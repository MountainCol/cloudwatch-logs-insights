#!/usr/bin/env bash
# Lab 12 readiness check: run this before the class (and again at the start).
# Read-only unless you add --install-agent.
#
#   ./check-readiness.sh [--region eu-west-2] [--install-agent]
#
# For every trainee web server and the traffic generator it shows whether the instance is running,
# has a public address, is registered ("Online") with Systems Manager, and carries the right tags.
# With --install-agent it then installs the CloudWatch agent package on every Online web server, by
# instance ID (so a mistyped tag cannot cause "Success on zero servers"). Trainees can then still do
# Task 1.3: it reports "already installed", and Task 1.4 works first time.

set -u
REGION="eu-west-2"; INSTALL="no"
while [ $# -gt 0 ]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --install-agent) INSTALL="yes"; shift ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
done
command -v aws >/dev/null || { echo "The AWS CLI (Command Line Interface) is not installed."; exit 2; }

ping_status() { # instance id -> Online / ConnectionLost / NotRegistered
  local p
  p=$(aws --region "$REGION" ssm describe-instance-information --filters "Key=InstanceIds,Values=$1" \
        --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null)
  if [ -z "$p" ] || [ "$p" = "None" ]; then echo "NotRegistered"; else echo "$p"; fi
}

BAD=0; ONLINE_IDS=""; WEB=0
echo "== Trainee web servers =="
printf "  %-21s %-8s %-15s %-16s %-14s %s\n" "InstanceId" "Trainee" "PrivateIp" "PublicIp" "SystemsMgr" "Tag check"
while read -r id tid priv pub tagval; do
  [ -z "$id" ] && continue
  WEB=$((WEB+1))
  st=$(ping_status "$id")
  tagnote="ok"
  [ "$tagval" = "$tid" ] || tagnote="CloudwatchAgentInstalled=$tagval (expected $tid)"
  printf "  %-21s %-8s %-15s %-16s %-14s %s\n" "$id" "$tid" "$priv" "$pub" "$st" "$tagnote"
  if [ "$st" = "Online" ]; then ONLINE_IDS="$ONLINE_IDS $id"; else BAD=$((BAD+1)); fi
  [ "$tagnote" = "ok" ] || BAD=$((BAD+1))
done < <(aws --region "$REGION" ec2 describe-instances \
  --filters "Name=tag:LabRole,Values=web" "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].[InstanceId,Tags[?Key==`Trainee`]|[0].Value,PrivateIpAddress,PublicIpAddress,Tags[?Key==`CloudwatchAgentInstalled`]|[0].Value]' \
  --output text | sort -k2)

echo; echo "== Traffic generator =="
while read -r id priv pub; do
  [ -z "$id" ] && continue
  st=$(ping_status "$id")
  printf "  %-21s %-15s %-16s %s\n" "$id" "$priv" "$pub" "$st"
  [ "$st" = "Online" ] || BAD=$((BAD+1))
done < <(aws --region "$REGION" ec2 describe-instances \
  --filters "Name=tag:LabRole,Values=generator" "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].[InstanceId,PrivateIpAddress,PublicIpAddress]' --output text)

echo
if [ "$WEB" -eq 0 ]; then echo "No running web servers found in $REGION. Is the stack deployed?"; exit 1; fi
echo "Web servers: $WEB found, $(echo $ONLINE_IDS | wc -w) Online in Systems Manager."
echo "A server that is NotRegistered usually has no route to the internet (check it has a public address in a"
echo "public subnet, or that the subnet has a NAT gateway or Systems Manager endpoints), or is still starting:"
echo "wait five minutes and run this again."

if [ "$INSTALL" = "yes" ]; then
  if [ -z "$ONLINE_IDS" ]; then echo "Nothing Online to install on."; exit 1; fi
  echo; echo "== Installing the CloudWatch agent package on the Online web servers =="
  CMD=$(aws --region "$REGION" ssm send-command --document-name AWS-ConfigureAWSPackage \
    --parameters action=Install,name=AmazonCloudWatchAgent --instance-ids $ONLINE_IDS \
    --query 'Command.CommandId' --output text)
  echo "  Command ID: $CMD"
  for i in $(seq 1 24); do
    sleep 10
    PENDING=$(aws --region "$REGION" ssm list-command-invocations --command-id "$CMD" \
      --query "length(CommandInvocations[?Status=='InProgress' || Status=='Pending'])" --output text)
    [ "$PENDING" = "0" ] && break
  done
  aws --region "$REGION" ssm list-command-invocations --command-id "$CMD" \
    --query 'CommandInvocations[].[InstanceId,Status]' --output table
fi

[ "$BAD" -eq 0 ] && echo "All checks passed." || { echo "$BAD problem(s) found above."; exit 1; }
