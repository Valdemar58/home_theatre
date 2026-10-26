#!/usr/bin/env bash
# Раздельное туннелирование при полном VPN-туннеле: домены из domains.txt и трафик с адресов
# из sources.txt (контейнеры торрентов) идут мимо VPN, напрямую через провайдера. Не зависит от VPN-клиента: приложение AmneziaVPN (amn0/vpn0,
# маршруты 0.0.0.0/1 + 128.0.0.0/1) и wg-quick / awg-quick (правило «not fwmark → таблица VPN»).
#
# Как работает:
#   dnsmasq (встроенный в NetworkManager) при ответе на DNS-запрос к домену из списка
#   кладёт IP в nftables-набор inet novpn bypass4 → пакеты к этим IP получают fwmark
#   WireGuard (0xca6c): wg-quick / awg-quick / AmneziaVPN сами пропускают такие пакеты мимо
#   туннеля («not fwmark 0xca6c → таблица VPN»), а наше правило отправляет их в таблицу
#   с провайдерским шлюзом (нужно для режима приложения Amnezia с маршрутами 0/1).
#   VPN-клиенты подменяют DNS (resolv.conf → 1.1.1.1), поэтому DNS-запросы хоста
#   перехватываются в локальный dnsmasq; сам dnsmasq ходит к 1.1.1.1 через VPN — утечки нет.
#   Работает и для хоста (Steam, docker pull), и для контейнеров (ollama pull).
#   IPv6 к этим доменам отклоняется (IPv6 есть только внутри VPN) — клиенты сразу уходят на IPv4.
#   sources.txt: пакеты с этих адресов (кроме адресатов в локальных/docker-сетях) получают ту же метку.
#
# Использование (от root):
#   sudo ./split-tunnel.sh install     — поставить (dnsmasq в NM, systemd-юнит, dispatcher) и включить
#   sudo ./split-tunnel.sh uninstall   — убрать всё
#   sudo split-tunnel up|down|refresh  — включить / выключить / обновить шлюз
#   split-tunnel status                — состояние;  split-tunnel check <домен> — куда пойдёт домен
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
BIN=/usr/local/sbin/split-tunnel
CONF_DIR=/etc/split-tunnel
NM_CONF=/etc/NetworkManager/conf.d/50-split-tunnel-dns.conf
NM_DNSMASQ=/etc/NetworkManager/dnsmasq.d/split-tunnel.conf
NM_DISPATCH=/etc/NetworkManager/dispatcher.d/90-split-tunnel
UNIT=/etc/systemd/system/split-tunnel.service

# Метка WireGuard по умолчанию (FwMark 51820): её VPN-правило «not fwmark» пропускает мимо туннеля.
# AmneziaVPN ставит свои правила РАНЬШЕ существующих, поэтому соревноваться приоритетами нельзя
MARK=0xca6c
OLD_MARK=0x5e7  # метка прошлых версий скрипта
TABLE=1515
PRIO=1000
NFT_TABLE=novpn
# DNS, к которому dnsmasq ходит сам (через VPN); те же, что ставит VPN-клиент
DNS_UPSTREAM=${SPLIT_DNS_UPSTREAM:-1.1.1.1,1.0.0.1}

die() { echo "Ошибка: $*" >&2; exit 1; }
need_root() { [[ $EUID -eq 0 ]] || die "нужен root: sudo $0 $*"; }

# VPN-интерфейс — только для вывода в status/check, маршрутизации он не нужен.
# SPLIT_VPN_IF переопределяет автоопределение
vpn_if() {
  [[ -n ${SPLIT_VPN_IF:-} ]] && { echo "$SPLIT_VPN_IF"; return; }
  local dev table
  # приложение AmneziaVPN: полный туннель двумя половинками 0.0.0.0/1 + 128.0.0.0/1 в main
  dev=$(ip -4 route show 0.0.0.0/1 | awk '{for (i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}')
  if [[ -z $dev ]]; then
    # wg-quick / awg-quick: «not from all fwmark X lookup N», default в таблице N
    table=$(ip -4 rule show | awk '/not from all fwmark/ {for (i=1;i<=NF;i++) if ($i=="lookup") {print $(i+1); exit}}')
    [[ -n $table ]] && dev=$(ip -4 route show default table "$table" | awk '{for (i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}')
  fi
  echo "${dev:-нет}"
}

# Провайдерский шлюз: default с «via» в main. Оба стиля VPN оставляют его на месте
# (у туннеля default без шлюза — «dev vpn0», такие пропускаем)
uplink() {
  ip -4 route show default | awk '
    { gw=""; dev="" ; for (i=1;i<=NF;i++) { if ($i=="via") gw=$(i+1); if ($i=="dev") dev=$(i+1) }
      if (gw!="") { print gw, dev; exit } }'
}

# Снять своё правило — строго по полному описанию: правило VPN «not fwmark 0xca6c» не трогаем
del_rules() {
  while ip rule del fwmark "$MARK" lookup "$TABLE" 2>/dev/null; do :; done
  while ip rule del fwmark "$OLD_MARK" 2>/dev/null; do :; done
}

# Пользователь, от которого NetworkManager запускает dnsmasq (его запросы не перехватываем)
dnsmasq_uid() {
  local u
  u=$(ps -o uid= -C dnsmasq 2>/dev/null | head -1 | tr -d ' ')
  echo "${u:-$(id -u nobody)}"
}

# Адреса-источники из sources.txt через запятую (пусто — правило не ставится)
sources() {
  local f="$CONF_DIR/sources.txt"
  [[ -f $f ]] || f="$SRC_DIR/sources.txt"
  [[ -f $f ]] || return 0
  sed 's/#.*//' "$f" | tr -d ' \t\r' | grep -E '^[0-9./]+$' | paste -sd, || true
}

nft_rules() {
  local src
  src=$(sources)
  cat <<EOF
table inet $NFT_TABLE {
  set bypass4 { type ipv4_addr; }
  set bypass6 { type ipv6_addr; }
  # контейнеры, которые целиком ходят мимо VPN (торренты)
  set bypass_src4 { type ipv4_addr; flags interval; ${src:+elements = { $src \}} }
  # локальные и docker-сети: туда трафик «мимо VPN» не помечаем
  set local4 { type ipv4_addr; flags interval; elements = { 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4 } }

  # пакеты контейнеров (docker-сети) — до маршрутизации
  chain prerouting {
    type filter hook prerouting priority mangle; policy accept;
    ip daddr @bypass4 meta mark set $MARK
    ip saddr @bypass_src4 ip daddr != @local4 meta mark set $MARK
  }
  # пакеты самого хоста — с перемаршрутизацией по метке
  chain output {
    type route hook output priority mangle; policy accept;
    ip daddr @bypass4 meta mark set $MARK
  }
  chain reject6 {
    type filter hook output priority filter; policy accept;
    ip6 daddr @bypass6 reject with icmpx type admin-prohibited
  }
  chain forward6 {
    type filter hook forward priority filter; policy accept;
    ip6 daddr @bypass6 reject with icmpx type admin-prohibited
  }
  # у хостового сокета адрес источника уже от VPN-интерфейса — подменяем на адрес uplink.
  # Только для наших адресов: пакеты самого WireGuard тоже несут эту метку
  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;
    ip daddr @bypass4 meta mark $MARK masquerade
    ip saddr @bypass_src4 meta mark $MARK masquerade
  }
}
EOF
  # DNS-запросы хоста (и встроенного DNS docker) — в локальный dnsmasq, даже если
  # VPN-клиент прописал в resolv.conf свой сервер. Запросы самого dnsmasq не трогаем.
  # Только если dnsmasq слушает 127.0.0.1:53 — иначе перехват сломал бы весь DNS
  if ss -Hlnu 'sport = :53' 2>/dev/null | grep -q '127.0.0.1:53'; then
    cat <<EOF
table inet $NFT_TABLE {
  chain dns {
    type nat hook output priority dstnat; policy accept;
    meta skuid $(dnsmasq_uid) return
    ip daddr != 127.0.0.0/8 udp dport 53 redirect to :53
    ip daddr != 127.0.0.0/8 tcp dport 53 redirect to :53
  }
}
EOF
  else
    echo "split-tunnel: dnsmasq не слушает 127.0.0.1:53 — DNS не перехватываю" >&2
  fi
}

dnsmasq_conf() {
  local f="$1" domains
  domains=$(grep -vE '^\s*(#|$)' "$f" | tr -d ' \t\r' | paste -sd/)
  [[ -n $domains ]] || die "список доменов пуст: $f"
  echo "# Сгенерировано split-tunnel.sh из $f — не править руками"
  echo "nftset=/$domains/4#inet#$NFT_TABLE#bypass4,6#inet#$NFT_TABLE#bypass6"
}

# сбросить кэш dnsmasq NetworkManager — иначе закэшированные ответы не попадут в пустые наборы
flush_dns_cache() {
  pkill -HUP -f 'dnsmasq.*NetworkManager' 2>/dev/null || true
}

cmd_refresh() {
  local gw dev
  read -r gw dev < <(uplink) || true
  [[ -n ${gw:-} ]] || { echo "нет провайдерского шлюза — пропускаю"; return 0; }
  ip route replace default via "$gw" dev "$dev" table "$TABLE"
}

cmd_up() {
  # после обновления ядра без перезагрузки модули nft_masq/nft_reject_inet не загрузятся
  [[ -d /usr/lib/modules/$(uname -r) ]] || die "ядро обновлено, а система не перезагружена — перезагрузитесь"
  nft list table inet "$NFT_TABLE" &>/dev/null && nft delete table inet "$NFT_TABLE"
  nft_rules | nft -f -
  del_rules
  ip rule add fwmark "$MARK" lookup "$TABLE" priority "$PRIO"
  cmd_refresh
  flush_dns_cache
  echo "split-tunnel: включено"
}

cmd_down() {
  del_rules
  ip route flush table "$TABLE" 2>/dev/null || true
  ip route flush table 1517 2>/dev/null || true  # таблица старой версии скрипта
  nft delete table inet "$NFT_TABLE" 2>/dev/null || true
  echo "split-tunnel: выключено"
}

# --- DNS-слой: dnsmasq внутри NetworkManager (десктоп) ---
# Серверный режим без NetworkManager (свой dnsmasq) добавляется парой функций dns_*
dns_install() {
  command -v NetworkManager >/dev/null || die "нет NetworkManager — серверный режим пока не реализован"
  command -v dnsmasq >/dev/null || pacman -S --needed --noconfirm dnsmasq
  dnsmasq --version | grep -qE '(^| )nftset( |$)' \
    || die "dnsmasq собран без nftset (см. 'dnsmasq --version')"
  # отдельный dnsmasq.service не нужен — NetworkManager запускает свой экземпляр
  systemctl is-enabled dnsmasq.service &>/dev/null && die "включён системный dnsmasq.service — он займёт порт 53"
  install -d /etc/NetworkManager/dnsmasq.d
  dnsmasq_conf "$CONF_DIR/domains.txt" > "$NM_DNSMASQ"
  # dnsmasq спрашивает тот же DNS, что выбрал бы VPN-клиент (через туннель), а не роутер провайдера
  printf '[main]\ndns=dnsmasq\n\n[global-dns-domain-*]\nservers=%s\n' "$DNS_UPSTREAM" > "$NM_CONF"
}

dns_uninstall() {
  rm -f "$NM_DNSMASQ" "$NM_CONF"
}

# применить конфиг DNS: перезапуск NM поднимает dnsmasq на 127.0.0.1 и переписывает resolv.conf
dns_apply() {
  systemctl restart NetworkManager
  sleep 3
  flush_dns_cache
}

cmd_install() {
  [[ -d /usr/lib/modules/$(uname -r) ]] || die "ядро обновлено, а система не перезагружена — перезагрузитесь"
  install -Dm755 "$SRC_DIR/split-tunnel.sh" "$BIN"
  install -Dm644 "$SRC_DIR/domains.txt" "$CONF_DIR/domains.txt"
  install -Dm644 "$SRC_DIR/sources.txt" "$CONF_DIR/sources.txt"
  dns_install

  cat > "$NM_DISPATCH" <<EOF
#!/bin/sh
# смена сети/шлюза — обновить маршрут мимо VPN
case "\$2" in up|dhcp4-change|connectivity-change) $BIN refresh ;; esac
EOF
  chmod 755 "$NM_DISPATCH"

  cat > "$UNIT" <<EOF
[Unit]
Description=Split tunnel: домены из $CONF_DIR/domains.txt мимо VPN
After=NetworkManager.service
Wants=NetworkManager.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$BIN up
ExecStop=$BIN down

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now NetworkManager-dispatcher.service
  systemctl enable split-tunnel.service
  systemctl restart split-tunnel.service
  # Wi-Fi может моргнуть
  dns_apply
  echo "Готово. Проверка: split-tunnel status; split-tunnel check store.steampowered.com"
  echo "Чтобы docker-контейнеры подхватили новый DNS: docker compose up -d --force-recreate"
}

cmd_uninstall() {
  systemctl disable --now split-tunnel.service 2>/dev/null || true
  cmd_down
  dns_uninstall
  rm -f "$UNIT" "$NM_DISPATCH" "$BIN"
  rm -rf "$CONF_DIR"
  systemctl daemon-reload
  dns_apply
  echo "split-tunnel: удалено"
}

cmd_status() {
  echo "resolv.conf: $(grep -m1 '^nameserver' /etc/resolv.conf)"
  echo "VPN: $(vpn_if)  uplink: $(uplink)"
  ip rule show fwmark "$MARK" 2>/dev/null | sed 's/^/rule: /'
  ip route show table "$TABLE" 2>/dev/null | sed 's/^/table: /'
  if nft list set inet "$NFT_TABLE" bypass4 &>/dev/null; then
    echo "IPv4 в наборе: $(nft list set inet "$NFT_TABLE" bypass4 | grep -oE '([0-9]+\.){3}[0-9]+' | wc -l)"
    echo "источники мимо VPN: $(nft list set inet "$NFT_TABLE" bypass_src4 | grep -oE '([0-9]+\.){3}[0-9]+(/[0-9]+)?' | paste -sd' ')"
  else
    echo "nft-таблица $NFT_TABLE не создана (нужен root для чтения или split-tunnel выключен)"
  fi
}

cmd_check() {
  local host="${1:?укажите домен}" ip
  ip=$(getent ahostsv4 "$host" | awk 'NR==1{print $1}')
  [[ -n $ip ]] || die "не резолвится: $host"
  local in_set="?"
  if nft list set inet "$NFT_TABLE" bypass4 &>/dev/null; then
    nft get element inet "$NFT_TABLE" bypass4 "{ $ip }" &>/dev/null && in_set=да || in_set=нет
  fi
  echo "$host → $ip, в наборе мимо VPN: $in_set"
  if [[ $in_set == да ]]; then ip route get "$ip" mark "$MARK"; else ip route get "$ip"; fi
}

case "${1:-}" in
  install)   need_root install;   cmd_install ;;
  uninstall) need_root uninstall; cmd_uninstall ;;
  up)        need_root up;        cmd_up ;;
  down)      need_root down;      cmd_down ;;
  refresh)   need_root refresh;   cmd_refresh ;;
  status)    cmd_status ;;
  check)     shift; cmd_check "$@" ;;
  *) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
