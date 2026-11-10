#!/usr/bin/env bash
# Lab 12: write one handout text file per trainee from the deployed stack outputs.
#
#   ./trainee-handout.sh --trainees t01,t02,t03 [--region eu-west-2] [--out handouts]
#
# Give each trainee their own file. It holds only names and addresses, no passwords.

set -u
REGION="eu-west-2"; TRAINEES=""; OUT="handouts"
while [ $# -gt 0 ]; do
  case "$1" in
    --trainees) TRAINEES="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
done
[ -n "$TRAINEES" ] || { echo "Usage: $0 --trainees t01,t02 [--region eu-west-2] [--out handouts]"; exit 2; }

out_of() { # stack, key
  aws --region "$REGION" cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text 2>/dev/null
}

BUCKET=$(out_of LogsLabShared LogBucketName)
ROLE=$(out_of LogsLabShared FlowLogsRoleName)
DBID=$(out_of LogsLabShared DbIdentifier)
DBEP=$(out_of LogsLabShared DbEndpoint)
TRAIL=$(out_of LogsLabShared CloudTrailLogGroupName)
[ -n "$BUCKET" ] || { echo "Cannot read stack LogsLabShared in $REGION. Is it deployed?"; exit 1; }

mkdir -p "$OUT"
for t in ${TRAINEES//,/ }; do
  S="LogsLab-$t"
  IID=$(out_of "$S" WebInstanceId); IP=$(out_of "$S" WebPrivateIp); PARAM=$(out_of "$S" AgentConfigParameter)
  if [ -z "$IID" ]; then echo "  skipped $t: stack $S not found"; continue; fi
  cat > "$OUT/$t.txt" <<EOF
LAB 12: COLLECTING AND ANALYSING LOGS WITH AMAZON CLOUDWATCH LOGS INSIGHTS
Trainee ID: $t          Region: $REGION (Europe, London)

Your web server (Linux)
  Instance name ........... LinuxEC2Host-$t
  Instance ID ............. $IID
  Private IP address ...... $IP

Names you will type
  Run Command, Task 1.3 ... tag key CloudwatchAgentInstalled, tag value $t
  Run Command, Task 1.4 ... tag key MonitoringConfig, tag value BasicMixOSMonitoring-$t
  Agent configuration ..... $PARAM
  Output bucket ........... $BUCKET   (S3 key prefix: $t)
  Flow log group (you create it) ... VPCFlowLogGroup-$t
  Flow log service role ... $ROLE
  Your log groups ......... AccessLogGroup-$t and SSHLogGroup-$t
  Metric filter names ..... accesslogs-404-errors-$t and ssh-invalid-user-$t
  Metric namespace ........ WebsiteLogMetrics

Shared by the whole class
  Database (RDS) .......... $DBID   endpoint $DBEP
  Database error log group  /aws/rds/instance/$DBID/error   (everyone's calls appear here: find yours by your private IP address)
  CloudTrail log group .... $TRAIL

Always add your trainee ID to anything you create by hand, for example VPCFlowLogGroup-$t.
EOF
  echo "  wrote $OUT/$t.txt"
done
