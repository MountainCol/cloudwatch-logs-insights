#!/usr/bin/env bash
# Lab 12 pre-flight check for an existing VPC (Virtual Private Cloud).
# Read-only: it only calls Describe/Get APIs. Run it as the instructor before deploying.
#
#   ./preflight-existing-vpc.sh --vpc-id vpc-0123456789abcdef0 [--region eu-west-2] [--trainees 12]
#
# It prints the subnets (so you can fill in lab-config.json) and checks the things that most
# often stop the lab: DNS settings, outbound paths, free addresses and service quotas.

set -u
REGION="eu-west-2"
VPC_ID=""
TRAINEES=15

while [ $# -gt 0 ]; do
  case "$1" in
    --vpc-id) VPC_ID="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --trainees) TRAINEES="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
done
[ -n "$VPC_ID" ] || { echo "Usage: $0 --vpc-id vpc-... [--region eu-west-2] [--trainees 12]"; exit 2; }
command -v aws >/dev/null || { echo "The AWS CLI (Command Line Interface) is not installed."; exit 2; }

PASS=0; WARN=0; FAIL=0
ok()   { echo "  [ OK ] $*"; PASS=$((PASS+1)); }
warn() { echo "  [WARN] $*"; WARN=$((WARN+1)); }
bad()  { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); }
q()    { aws --region "$REGION" "$@" 2>/dev/null; }

echo "== 1. Who am I? =="
IDENT=$(aws --region "$REGION" sts get-caller-identity --query '[Account,Arn]' --output text 2>&1) \
  && ok "Signed in: $IDENT" || { bad "Cannot call AWS: $IDENT"; exit 1; }

echo; echo "== 2. VPC =="
VPC_CIDR=$(q ec2 describe-vpcs --vpc-ids "$VPC_ID" --query 'Vpcs[0].CidrBlock' --output text)
[ -n "$VPC_CIDR" ] && [ "$VPC_CIDR" != "None" ] && ok "VPC $VPC_ID found ($VPC_CIDR) in $REGION" || { bad "VPC $VPC_ID not found in $REGION"; exit 1; }
DNS_SUP=$(q ec2 describe-vpc-attribute --vpc-id "$VPC_ID" --attribute enableDnsSupport --query 'EnableDnsSupport.Value' --output text)
DNS_HOST=$(q ec2 describe-vpc-attribute --vpc-id "$VPC_ID" --attribute enableDnsHostnames --query 'EnableDnsHostnames.Value' --output text)
[ "$DNS_SUP" = "True" ] && ok "DNS resolution is enabled" || bad "enableDnsSupport is off: the database name will not resolve"
[ "$DNS_HOST" = "True" ] && ok "DNS hostnames are enabled" || warn "enableDnsHostnames is off: needed if you use interface endpoints for Systems Manager"

echo; echo "== 3. Subnets (copy the ones you want into lab-config.json) =="
printf "  %-24s %-12s %-16s %-8s %-8s %s\n" "SubnetId" "AZ" "CIDR" "FreeIPs" "AutoIP" "Name"
q ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" \
  --query 'Subnets[].[SubnetId,AvailabilityZone,CidrBlock,AvailableIpAddressCount,MapPublicIpOnLaunch,Tags[?Key==`Name`]|[0].Value]' \
  --output text | while read -r sid az cidr free mapip name; do
  printf "  %-24s %-12s %-16s %-8s %-8s %s\n" "$sid" "$az" "$cidr" "$free" "$mapip" "${name:-}"
done
NEED=$((TRAINEES + 6))
echo "  Addresses needed across the web subnets: about $NEED (one per trainee plus the generator and spare)."
echo "  The shared database needs 1 to 2 addresses in each database subnet."

echo; echo "== 4. Where does each subnet send internet-bound traffic? =="
MAIN_RT=$(q ec2 describe-route-tables --filters "Name=vpc-id,Values=$VPC_ID" "Name=association.main,Values=true" --query 'RouteTables[0].RouteTableId' --output text)
for sid in $(q ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" --query 'Subnets[].SubnetId' --output text); do
  RT=$(q ec2 describe-route-tables --filters "Name=association.subnet-id,Values=$sid" --query 'RouteTables[0].RouteTableId' --output text)
  if [ -z "$RT" ] || [ "$RT" = "None" ]; then RT="$MAIN_RT"; fi
  TARGET=$(q ec2 describe-route-tables --route-table-ids "$RT" \
    --query 'RouteTables[0].Routes[?DestinationCidrBlock==`0.0.0.0/0`]|[0].[GatewayId,NatGatewayId]' --output text | tr -s '[:space:]' ' ')
  echo "  $sid  route table $RT  default route -> ${TARGET:-none}"
done
echo "  Web subnets need a default route to a NAT (Network Address Translation) gateway or an internet gateway,"
echo "  or VPC endpoints, so the instances can reach package repositories and Systems Manager."

echo; echo "== 5. VPC endpoints already present =="
EPS=$(q ec2 describe-vpc-endpoints --filters "Name=vpc-id,Values=$VPC_ID" --query 'VpcEndpoints[].ServiceName' --output text)
if [ -z "$EPS" ]; then echo "  none (fine if the subnets have a NAT gateway or internet gateway)"; else for e in $EPS; do echo "  $e"; done; fi

echo; echo "== 6. Quotas (Service Quotas; blank means the lookup failed, check the console) =="
VCPU=$(aws --region "$REGION" service-quotas get-service-quota --service-code ec2 --quota-code L-1216C47A --query 'Quota.Value' --output text 2>/dev/null)
NEEDV=$(( (TRAINEES + 1) * 2 ))
if [ -n "$VCPU" ]; then
  echo "  Running On-Demand Standard instances: limit $VCPU vCPUs; this lab adds $NEEDV vCPUs (t3.micro = 2 vCPUs each)."
  awk "BEGIN{exit !($VCPU >= $NEEDV)}" && ok "Limit is at least the lab's need (existing usage is not counted: check the console)" || bad "Limit is below what the lab needs"
else warn "Could not read the vCPU quota"; fi
DBQ=$(aws --region "$REGION" service-quotas get-service-quota --service-code rds --quota-code L-7B6409FD --query 'Quota.Value' --output text 2>/dev/null)
[ -n "$DBQ" ] && echo "  RDS DB instances: limit $DBQ; this lab adds 1 (shared database)." || warn "Could not read the RDS quota"

echo; echo "== 7. Existing CloudTrail trails in this Region (a lab trail adds a second copy of management events) =="
q cloudtrail describe-trails --query 'trailList[].[Name,HomeRegion,IsMultiRegionTrail,CloudWatchLogsLogGroupArn]' --output text | sed 's/^/  /'

echo; echo "== Summary: $PASS ok, $WARN warnings, $FAIL failures =="
[ "$FAIL" -eq 0 ] || exit 1
