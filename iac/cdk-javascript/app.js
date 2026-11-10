#!/usr/bin/env node
// Lab 12: Collecting and analysing logs with Amazon CloudWatch Logs Insights.
// AWS Cloud Development Kit (CDK) app in JavaScript. Existing-VPC route only.
//
// Stacks
//   LogsLabShared     one shared Amazon RDS (Relational Database Service) MySQL instance, the
//                     traffic generator, the Amazon S3 bucket for Run Command output, the
//                     flow-log IAM role and (optionally) an AWS CloudTrail trail.
//   LogsLab-<id>      one per trainee: a Linux web server, its security group, its agent
//                     configuration in Parameter Store and its two Amazon CloudWatch log groups.
//
// Configuration comes from lab-config.json (see lab-config.example.json); any of the simple
// values can be overridden with  -c name=value  on the command line.

const fs = require('fs');
const path = require('path');
const { App, Stack, Duration, RemovalPolicy, CfnOutput, Tags } = require('aws-cdk-lib');
const ec2 = require('aws-cdk-lib/aws-ec2');
const iam = require('aws-cdk-lib/aws-iam');
const logs = require('aws-cdk-lib/aws-logs');
const rds = require('aws-cdk-lib/aws-rds');
const s3 = require('aws-cdk-lib/aws-s3');
const ssm = require('aws-cdk-lib/aws-ssm');
const cloudtrail = require('aws-cdk-lib/aws-cloudtrail');

// ---------------------------------------------------------------- configuration
const app = new App();
const configFile = app.node.tryGetContext('configFile') || path.join(__dirname, 'lab-config.json');
let fileConfig = {};
if (fs.existsSync(configFile)) {
  fileConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
}
function setting(name, fallback) {
  const fromCli = app.node.tryGetContext(name);
  if (fromCli !== undefined) return fromCli;
  return fileConfig[name] !== undefined ? fileConfig[name] : fallback;
}
function asList(v) {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}
function asBool(v, fallback) {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v;
  return String(v).toLowerCase() === 'true';
}

const region = setting('region', 'eu-west-2');
const vpcId = setting('vpcId', '');
const webSubnets = setting('webSubnets', []); // [{ id, az }]
const dbSubnets = setting('dbSubnets', []); //   [{ id, az }] two or more, different AZs
const assignPublicIp = asBool(setting('assignPublicIp', false), false);
const webIngressCidr = setting('webIngressCidr', '');
const instanceType = setting('instanceType', 't3.micro');
const generatorInstanceType = setting('generatorInstanceType', 't3.micro');
const dbInstanceClass = setting('dbInstanceClass', 't3.small');
const enableDbErrorLogExport = asBool(setting('enableDbErrorLogExport', true), true);
const createTrail = asBool(setting('createTrail', true), true);
const traineeIds = asList(setting('traineeIds', []));

function fail(msg) {
  throw new Error('lab-config problem: ' + msg);
}
if (!/^vpc-[0-9a-f]+$/.test(vpcId)) fail('vpcId must look like vpc-0123456789abcdef0');
if (!Array.isArray(webSubnets) || webSubnets.length < 1) fail('webSubnets needs at least one { id, az }');
if (!Array.isArray(dbSubnets) || dbSubnets.length < 2) fail('dbSubnets needs at least two { id, az }');
if (new Set(dbSubnets.map((s) => s.az)).size < 2) fail('dbSubnets must cover at least two Availability Zones');
[...webSubnets, ...dbSubnets].forEach((s) => {
  if (!/^subnet-[0-9a-f]+$/.test(s.id || '') || !s.az) fail('every subnet needs an id (subnet-...) and an az');
});
if (traineeIds.length < 1) fail('traineeIds is empty (for example "t01,t02,t03")');
// Refuse the example values from lab-config.example.json: deploying them fails late and confusingly.
const examplePlaceholders = ['vpc-0123456789abcdef0', 'subnet-0aaaaaaaaaaaaaaaa', 'subnet-0bbbbbbbbbbbbbbbb', 'subnet-0cccccccccccccccc', 'subnet-0dddddddddddddddd'];
if (examplePlaceholders.includes(vpcId) || [...webSubnets, ...dbSubnets].some((x) => examplePlaceholders.includes(x.id))) {
  fail('the VPC or subnet IDs are still the example values from lab-config.example.json. Put your own IDs in lab-config.json (scripts/preflight-existing-vpc.sh prints them).');
}
traineeIds.forEach((id) => {
  if (!/^[a-z][a-z0-9]{1,7}$/.test(id)) fail(`trainee ID "${id}" must be 2-8 characters, lower case letters and digits, starting with a letter`);
});
if (new Set(traineeIds).size !== traineeIds.length) fail('traineeIds contains duplicates');

const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region };
const allAzs = [...new Set([...webSubnets, ...dbSubnets].map((s) => s.az))];

// ---------------------------------------------------------------- helpers
function importVpc(scope) {
  return ec2.Vpc.fromVpcAttributes(scope, 'Vpc', { vpcId, availabilityZones: allAzs });
}
function importSubnet(scope, logicalId, s) {
  return ec2.Subnet.fromSubnetAttributes(scope, logicalId, { subnetId: s.id, availabilityZone: s.az });
}
// Give an instance a public IPv4 address. The CDK's own associatePublicIpAddress option refuses to work
// with subnets imported by ID ("you must select Public subnets"), because an imported subnet is not known
// to be public. So the network interface is set directly on the underlying CloudFormation resource.
function attachPublicIp(instance, subnetId, securityGroupId) {
  const cfn = instance.instance; // the low-level CfnInstance
  cfn.networkInterfaces = [{ deviceIndex: '0', associatePublicIpAddress: true, subnetId, groupSet: [securityGroupId] }];
  cfn.subnetId = undefined;
  cfn.securityGroupIds = undefined;
}

// A here-document so a whole script file can be written from instance user data.
function writeFile(target, lines, mode) {
  return [`cat > ${target} <<'LABEOF'`, ...lines, 'LABEOF', `chmod ${mode || '644'} ${target}`];
}

// ---------------------------------------------------------------- shared stack
class SharedStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const vpc = importVpc(this);

    // Bucket that receives AWS Systems Manager Run Command output (Tasks 1.3 and 1.4).
    const logBucket = new s3.Bucket(this, 'LogBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // IAM role for VPC Flow Logs to write into log groups named VPCFlowLogGroup-<id> (Task 2).
    const flowRole = new iam.Role(this, 'FlowLogsRole', {
      roleName: 'LogsLab-VPCFlowLogsRole',
      assumedBy: new iam.ServicePrincipal('vpc-flow-logs.amazonaws.com'),
      description: 'Lets VPC Flow Logs publish to VPCFlowLogGroup-* log groups',
    });
    flowRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:DescribeLogGroups', 'logs:DescribeLogStreams'],
      resources: ['*'],
    }));
    flowRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`arn:${this.partition}:logs:${this.region}:${this.account}:log-group:VPCFlowLogGroup-*:*`],
    }));

    // Optional CloudTrail trail delivering management events to the CloudTrailLogGroup log group (Q4).
    if (createTrail) {
      const trailBucket = new s3.Bucket(this, 'TrailBucket', {
        encryption: s3.BucketEncryption.S3_MANAGED,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        removalPolicy: RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
      });
      const trailLogGroup = new logs.LogGroup(this, 'CloudTrailLogGroup', {
        logGroupName: 'CloudTrailLogGroup',
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      new cloudtrail.Trail(this, 'Trail', {
        trailName: 'LogsLab-Trail',
        bucket: trailBucket,
        sendToCloudWatchLogs: true,
        cloudWatchLogGroup: trailLogGroup,
        includeGlobalServiceEvents: true,
        isMultiRegionTrail: false,
        managementEvents: cloudtrail.ReadWriteType.ALL,
      });
    }

    // Shared database: ONE MySQL instance for the whole class, in the private subnets.
    this.dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc,
      description: 'Lab 12 shared database: MySQL from trainee web servers only',
      allowAllOutbound: false,
    });
    const subnetGroup = new rds.SubnetGroup(this, 'DbSubnetGroup', {
      description: 'Lab 12 shared database subnet group',
      vpc,
      vpcSubnets: { subnets: dbSubnets.map((s, i) => importSubnet(this, `DbSubnet${i}`, s)) },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.db = new rds.DatabaseInstance(this, 'Db', {
      instanceIdentifier: 'labdb-shared',
      engine: rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_8_0 }),
      instanceType: new ec2.InstanceType(dbInstanceClass),
      vpc,
      subnetGroup,
      securityGroups: [this.dbSg],
      credentials: rds.Credentials.fromGeneratedSecret('labadmin'),
      allocatedStorage: 20,
      storageEncrypted: true,
      multiAz: false,
      publiclyAccessible: false,
      backupRetention: Duration.days(0),
      deletionProtection: false,
      deleteAutomatedBackups: true,
      removalPolicy: RemovalPolicy.DESTROY,
      // The error-log export is switched on here so the whole class shares one setting.
      // Set enableDbErrorLogExport to false if you prefer to demonstrate it live (guide, Task 3).
      cloudwatchLogsExports: enableDbErrorLogExport ? ['error'] : undefined,
    });

    // Traffic generator: one small instance that calls every trainee web server (see guide).
    this.generatorSg = new ec2.SecurityGroup(this, 'GeneratorSg', {
      vpc,
      description: 'Lab 12 traffic generator',
      allowAllOutbound: true,
    });
    const genRole = new iam.Role(this, 'GeneratorRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    genRole.addToPolicy(new iam.PolicyStatement({ actions: ['ec2:DescribeInstances'], resources: ['*'] }));

    const genUserData = ec2.UserData.forLinux();
    genUserData.addCommands(
      'set -x',
      'dnf install -y openssh-clients',
      'mkdir -p /opt/lab',
      `echo "LAB_REGION=${this.region}" > /opt/lab/gen.env`,
      ...writeFile('/opt/lab/generate-traffic.sh', [
        '#!/bin/bash',
        '# Lab 12 traffic generator: ordinary requests, missing pages, closed-port probes and',
        '# invalid SSH log-ins against every running trainee web server. Training use only.',
        '. /opt/lab/gen.env',
        'probe() {',
        '  ip="$1"; UA=""',
        '  case $((RANDOM % 3)) in',
        '    0) UA="Mozilla/5.0 (X11; Linux x86_64) TrainingBrowser/1.0" ;;',
        '    1) UA="lab-healthcheck/1.0" ;;',
        '    *) UA="curl-training/1.0" ;;',
        '  esac',
        '  for i in 1 2 3 4 5 6; do curl -s -o /dev/null -m 3 -A "$UA" "http://$ip/"; done',
        '  for p in missing.html wp-login.php admin/ old-page.html; do curl -s -o /dev/null -m 3 -A "$UA" "http://$ip/$p"; done',
        '  for port in 23 3389 8080; do timeout 2 bash -c "echo > /dev/tcp/$ip/$port" 2>/dev/null; done',
        '  for u in admin test ec2-user; do',
        '    ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=3 "$u@$ip" true >/dev/null 2>&1',
        '  done',
        '}',
        'while true; do',
        '  TARGETS=$(aws ec2 describe-instances --region "$LAB_REGION" \\',
        '    --filters "Name=tag:LabName,Values=cloudwatch-logs-insights" "Name=tag:LabRole,Values=web" "Name=instance-state-name,Values=running" \\',
        "    --query 'Reservations[].Instances[].PrivateIpAddress' --output text 2>/dev/null)",
        '  # One background job per server, so 15 servers take about as long as one.',
        '  for ip in $TARGETS; do probe "$ip" & done',
        '  wait',
        '  sleep 60',
        'done',
      ], '755'),
      ...writeFile('/etc/systemd/system/lab-generator.service', [
        '[Unit]',
        'Description=Lab 12 traffic generator',
        'After=network-online.target',
        'Wants=network-online.target',
        '[Service]',
        'ExecStart=/opt/lab/generate-traffic.sh',
        'Restart=always',
        '[Install]',
        'WantedBy=multi-user.target',
      ]),
      'systemctl daemon-reload',
      'systemctl enable --now lab-generator.service',
    );
    const generator = new ec2.Instance(this, 'Generator', {
      vpc,
      instanceType: new ec2.InstanceType(generatorInstanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      role: genRole,
      securityGroup: this.generatorSg,
      vpcSubnets: { subnets: [importSubnet(this, 'GeneratorSubnet', webSubnets[0])] },
      // Do NOT set requireImdsv2 here: it makes the CDK create a launch template whose name is the same
      // in every stack, which breaks parallel deployments. Amazon Linux 2023 images already default to
      // the more secure instance-metadata version (IMDSv2).
      instanceName: 'LogsLab-TrafficGenerator',
      userData: genUserData,
      userDataCausesReplacement: true,
    });
    if (assignPublicIp) attachPublicIp(generator, webSubnets[0].id, this.generatorSg.securityGroupId);
    Tags.of(generator).add('LabName', 'cloudwatch-logs-insights');
    Tags.of(generator).add('LabRole', 'generator');

    this.logBucketName = logBucket.bucketName;
    new CfnOutput(this, 'LogBucketName', { value: logBucket.bucketName, description: 'Choose this bucket for Run Command output' });
    new CfnOutput(this, 'FlowLogsRoleName', { value: flowRole.roleName });
    new CfnOutput(this, 'DbIdentifier', { value: this.db.instanceIdentifier });
    new CfnOutput(this, 'DbEndpoint', { value: this.db.dbInstanceEndpointAddress });
    new CfnOutput(this, 'GeneratorInstanceId', { value: generator.instanceId });
    new CfnOutput(this, 'CloudTrailLogGroupName', { value: createTrail ? 'CloudTrailLogGroup' : '(trail not created)' });
    Tags.of(this).add('LabName', 'cloudwatch-logs-insights');
  }
}

// ---------------------------------------------------------------- trainee stack
class TraineeStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const tid = props.traineeId;
    const vpc = importVpc(this);

    // Log groups are created here (so the stack removes them), and the agent writes into them.
    ['AccessLogGroup', 'SSHLogGroup'].forEach((base) => {
      new logs.LogGroup(this, base, {
        logGroupName: `${base}-${tid}`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      });
    });

    // Agent configuration that trainees apply with Run Command (Task 1.4).
    const paramName = `ConfigParamForEC2s-${tid}`;
    const agentConfig = {
      agent: { run_as_user: 'root' },
      logs: {
        logs_collected: {
          files: {
            collect_list: [
              { file_path: '/var/log/httpd/access_log', log_group_name: `AccessLogGroup-${tid}`, log_stream_name: '{instance_id}-http.log' },
              { file_path: '/var/log/secure', log_group_name: `SSHLogGroup-${tid}`, log_stream_name: '{instance_id}-secure.log' },
            ],
          },
        },
      },
    };
    new ssm.StringParameter(this, 'AgentConfig', {
      parameterName: paramName,
      description: `CloudWatch agent configuration for lab 12, trainee ${tid}`,
      stringValue: JSON.stringify(agentConfig),
    });

    // Security groups.
    const webSg = new ec2.SecurityGroup(this, 'WebSg', {
      vpc,
      description: `Lab 12 web server, trainee ${tid}`,
      allowAllOutbound: true,
    });
    webSg.addIngressRule(ec2.Peer.securityGroupId(props.generatorSgId), ec2.Port.tcp(80), 'HTTP from the traffic generator');
    webSg.addIngressRule(ec2.Peer.securityGroupId(props.generatorSgId), ec2.Port.tcp(22), 'SSH from the traffic generator (so invalid log-ins reach the SSH log)');
    if (webIngressCidr) {
      webSg.addIngressRule(ec2.Peer.ipv4(webIngressCidr), ec2.Port.tcp(80), 'Optional browser access from the CIDR chosen by the instructor');
    }
    // Rule lives in this stack, on the shared database security group.
    const dbSgRef = ec2.SecurityGroup.fromSecurityGroupId(this, 'DbSgRef', props.dbSgId, { mutable: true });
    dbSgRef.addIngressRule(webSg, ec2.Port.tcp(3306), `MySQL from web server of trainee ${tid}`);

    // Instance role.
    const role = new iam.Role(this, 'WebRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [`arn:${this.partition}:ssm:${this.region}:${this.account}:parameter/${paramName}`],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:PutObjectAcl', 's3:GetEncryptionConfiguration', 's3:GetBucketLocation'],
      resources: [`arn:${this.partition}:s3:::${props.logBucketName}`, `arn:${this.partition}:s3:::${props.logBucketName}/*`],
    }));

    // User data: Apache, rsyslog (so /var/log/secure exists on Amazon Linux 2023), MySQL client,
    // and a small background service that makes legitimate and wrong-port database calls.
    const ud = ec2.UserData.forLinux();
    ud.addCommands(
      'set -x',
      'dnf install -y httpd rsyslog mariadb105',
      'systemctl enable --now rsyslog',
      'systemctl enable --now httpd',
      `echo '<html><body><h1>Log collection lab</h1><p>A simple web page hosted on Amazon Linux (trainee ${tid}).</p></body></html>' > /var/www/html/index.html`,
      'mkdir -p /opt/lab',
      `echo "DB_HOST=${props.dbEndpoint}" > /opt/lab/lab.env`,
      ...writeFile('/opt/lab/db-calls.sh', [
        '#!/bin/bash',
        '# Lab 12: a web tier calling its database tier. One call uses the right port with a wrong',
        '# password (fails inside MySQL). One uses the wrong port 4306 (blocked by the network).',
        '. /opt/lab/lab.env',
        'MYSQL_BIN="$(command -v mariadb || command -v mysql)"',
        'while true; do',
        '  "$MYSQL_BIN" -h "$DB_HOST" -P 3306 -u labapp -p\'NotTheRealPassword1\' --connect-timeout=5 -e "SELECT 1" >/dev/null 2>&1',
        '  timeout 3 bash -c "echo > /dev/tcp/$DB_HOST/4306" 2>/dev/null',
        '  sleep 60',
        'done',
      ], '755'),
      ...writeFile('/etc/systemd/system/lab-db-calls.service', [
        '[Unit]',
        'Description=Lab 12 database calls',
        'After=network-online.target',
        'Wants=network-online.target',
        '[Service]',
        'ExecStart=/opt/lab/db-calls.sh',
        'Restart=always',
        '[Install]',
        'WantedBy=multi-user.target',
      ]),
      'systemctl daemon-reload',
      'systemctl enable --now lab-db-calls.service',
    );

    const web = new ec2.Instance(this, 'Web', {
      vpc,
      instanceType: new ec2.InstanceType(instanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      role,
      securityGroup: webSg,
      vpcSubnets: { subnets: [importSubnet(this, 'WebSubnet', props.subnet)] },
      // No requireImdsv2 (see the note on the generator): it creates a launch template with a name that
      // clashes between trainee stacks. Amazon Linux 2023 defaults to IMDSv2.
      instanceName: `LinuxEC2Host-${tid}`,
      userData: ud,
    });
    if (assignPublicIp) attachPublicIp(web, props.subnet.id, webSg.securityGroupId);
    // Tags used by Run Command (Tasks 1.3 and 1.4) and by the traffic generator.
    Tags.of(web).add('Trainee', tid);
    Tags.of(web).add('LabName', 'cloudwatch-logs-insights');
    Tags.of(web).add('LabRole', 'web');
    Tags.of(web).add('CloudwatchAgentInstalled', tid);
    Tags.of(web).add('MonitoringConfig', `BasicMixOSMonitoring-${tid}`);

    new CfnOutput(this, 'WebInstanceId', { value: web.instanceId });
    new CfnOutput(this, 'WebPrivateIp', { value: web.instancePrivateIp });
    new CfnOutput(this, 'AgentConfigParameter', { value: paramName });
    new CfnOutput(this, 'LogGroups', { value: `AccessLogGroup-${tid}, SSHLogGroup-${tid}` });
    Tags.of(this).add('Trainee', tid);
    Tags.of(this).add('LabName', 'cloudwatch-logs-insights');
  }
}

// ---------------------------------------------------------------- wiring
const shared = new SharedStack(app, 'LogsLabShared', { env });
traineeIds.forEach((tid, i) => {
  const stack = new TraineeStack(app, `LogsLab-${tid}`, {
    env,
    traineeId: tid,
    subnet: webSubnets[i % webSubnets.length], // spread trainees across the web subnets
    generatorSgId: shared.generatorSg.securityGroupId,
    dbSgId: shared.dbSg.securityGroupId,
    dbEndpoint: shared.db.dbInstanceEndpointAddress,
    logBucketName: shared.logBucketName,
  });
  stack.addDependency(shared);
});
