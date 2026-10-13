#!/bin/sh
set -eu
umask 077
# Provider DNS resolution happens in the egress proxy, never in this namespace.
iptables -P OUTPUT DROP
iptables -A OUTPUT -d 127.0.0.11 -j REJECT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -p tcp -d 172.30.91.2 --dport 3128 -j ACCEPT
iptables -A OUTPUT -j REJECT
ip6tables -P OUTPUT DROP
ip6tables -A OUTPUT -o lo -j ACCEPT
ip6tables -A OUTPUT -j REJECT
mkdir -p /data/home /data/profile /data/chats
chown 10001:10001 /data /data/home /data/profile /data/chats
exec setpriv --reuid=10001 --regid=10001 --init-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs "$@"
