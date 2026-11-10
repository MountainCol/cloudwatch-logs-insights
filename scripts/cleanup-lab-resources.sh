#!/usr/bin/env bash
# Lab 12 clean-up of things trainees (or AWS) created by hand, outside the CDK stacks.
#
# Order of a full tear-down:
#   1.  ./cleanup-lab-resources.sh --trainees t01,t02 --phase before
#   2.  cd iac/cdk-javascript && npx cdk destroy --all
#   3.  ./cleanup-lab-resources.sh --trainees t01,t02 --phase after
#
# phase before: flow logs that publish to VPCFlowLogGroup-<id>, then those log groups.
# phase after : the database error log group (kept by AWS after the database is deleted),
#               and any alarms trainees named <id>-...
# It shows what it found and asks before deleting, unless you pass --yes.

set -u
REGION="eu-west-2"; TRAINEES=""; PHASE=""; YES="no"
while [ $# -gt 0 ]; do
  case "$1" in
    --trainees) TRAINEES="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --phase) PHASE="$2"; shift 2 ;;
    --yes) YES="yes"; shift ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
done
[ -n "$TRAINEES" ] && { [ "$PHASE" = "before" ] || [ "$PHASE" = "after" ]; } || {
  echo "Usage: $0 --trainees t01,t02 --phase before|after [--region eu-west-2] [--yes]"; exit 2; }

q() { aws --region "$REGION" "$@" 2>/dev/null; }
FLOW_IDS=""; GROUPS_TO_DELETE=""; ALARMS=""

if [ "$PHASE" = "before" ]; then
  for t in ${TRAINEES//,/ }; do
    G="VPCFlowLogGroup-$t"
    for f in $(q ec2 describe-flow-logs --filter "Name=log-group-name,Values=$G" --query 'FlowLogs[].FlowLogId' --output text); do
      FLOW_IDS="$FLOW_IDS $f"
    done
    if [ "$(q logs describe-log-groups --log-group-name-prefix "$G" --query "logGroups[?logGroupName=='$G']|length(@)" --output text)" != "0" ]; then
      GROUPS_TO_DELETE="$GROUPS_TO_DELETE $G"
    fi
  done
else
  G="/aws/rds/instance/labdb-shared/error"
  if [ "$(q logs describe-log-groups --log-group-name-prefix "$G" --query "logGroups[?logGroupName=='$G']|length(@)" --output text)" != "0" ]; then
    GROUPS_TO_DELETE="$G"
  fi
  for t in ${TRAINEES//,/ }; do
    for a in $(q cloudwatch describe-alarms --alarm-name-prefix "$t-" --query 'MetricAlarms[].AlarmName' --output text); do
      ALARMS="$ALARMS $a"
    done
  done
fi

echo "Phase: $PHASE   Region: $REGION"
echo "  Flow logs to delete ......: ${FLOW_IDS:-none}"
echo "  Log groups to delete .....: ${GROUPS_TO_DELETE:-none}"
echo "  Alarms to delete .........: ${ALARMS:-none}"
if [ -z "$FLOW_IDS$GROUPS_TO_DELETE$ALARMS" ]; then echo "Nothing to do."; exit 0; fi

if [ "$YES" != "yes" ]; then
  read -r -p "Delete these? Type yes to continue: " ANS
  [ "$ANS" = "yes" ] || { echo "Cancelled."; exit 1; }
fi

[ -n "$FLOW_IDS" ] && aws --region "$REGION" ec2 delete-flow-logs --flow-log-ids $FLOW_IDS
for g in $GROUPS_TO_DELETE; do aws --region "$REGION" logs delete-log-group --log-group-name "$g" && echo "  deleted log group $g"; done
[ -n "$ALARMS" ] && aws --region "$REGION" cloudwatch delete-alarms --alarm-names $ALARMS && echo "  deleted alarms"
echo "Done."
