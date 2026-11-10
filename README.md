# Lab 12: Collecting and analysing logs with Amazon CloudWatch Logs Insights

Set-up code for the lab described in `Lab-Guide-CloudWatch-Logs-Insights.docx`. Read the guide first (Part C is the set-up and tear-down).

Region: Europe (London) `eu-west-2`. Infrastructure as Code (IaC): AWS Cloud Development Kit (CDK) in JavaScript. Existing Virtual Private Cloud (VPC) only. Linux web servers only. One shared Amazon Relational Database Service (RDS) MySQL instance for the whole class.

## Contents

| Path | Purpose |
|---|---|
| `iac/cdk-javascript/app.js`, `package.json`, `cdk.json` | The CDK app: one shared stack plus one stack per trainee |
| `lab-config.example.json` | Copy to `iac/cdk-javascript/lab-config.json` and fill in |
| `scripts/preflight-existing-vpc.sh` | Read-only checks of your VPC, subnets, routes, endpoints and quotas |
| `scripts/check-readiness.sh` | Run before class: are all servers Online in Systems Manager with correct tags? `--install-agent` installs the CloudWatch agent on all of them by instance ID |
| `scripts/trainee-handout.sh` | Writes one handout file per trainee from the deployed stack outputs |
| `scripts/cleanup-lab-resources.sh` | Removes the things made by hand (flow logs, log groups, alarms) |
| `trainee-policy.example.json` | Example permissions for trainee users (untested; see guide, Appendix A) |

## Quick start (instructor)

```bash
./scripts/preflight-existing-vpc.sh --vpc-id vpc-XXXX --trainees 3
cp lab-config.example.json iac/cdk-javascript/lab-config.json   # then edit it
cd iac/cdk-javascript && npm install
npx cdk synth
npx cdk bootstrap            # once per account and Region, if not already done
npx cdk deploy --all --concurrency 5 --require-approval never
cd ../.. && ./scripts/check-readiness.sh            # add --install-agent to pre-install the agent everywhere
./scripts/trainee-handout.sh --trainees t01,t02,...
```

## Tear-down

```bash
./scripts/cleanup-lab-resources.sh --trainees t01,t02,... --phase before
(cd iac/cdk-javascript && npx cdk destroy --all)
./scripts/cleanup-lab-resources.sh --trainees t01,t02,... --phase after
```

## Status

Version 1.2. Version 1.0 failed on a launch-template name clash (removed `requireImdsv2`). Version 1.1 could not give servers public addresses because the CDK refuses `associatePublicIpAddress` for subnets imported by ID; 1.2 sets the network interface on the underlying instance resource instead. Not yet redeployed: run the pilot checklist (guide, Appendix C).
