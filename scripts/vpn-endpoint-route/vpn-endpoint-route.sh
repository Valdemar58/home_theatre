#!/usr/bin/env bash
# Постоянный маршрут до VPN-серверов мимо туннеля — обход бага AmneziaVPN (Linux).
#
# Баг: служба Amnezia ищет шлюз, читая дамп ВСЕХ маршрутов в буфер 8 КБ
# (NetworkUtilities::getGatewayAndIface). Когда Docker-интерфейсов много, дамп больше 8 КБ →
# «No default gateway available, skipping exclusion route» → пакеты к серверу уходят в сам
# туннель → «sendmmsg: message too long», сайты не открываются.
#
# Решение: правило «to <сервер> lookup 1518» + в таблице 1518 провайдерский шлюз.
# Отдельная таблица — Amnezia её не видит и не удаляет; работает в любой сети
# (шлюз обновляется хуком NetworkManager при подключении/смене DHCP).
#
# Использование (от root):
#   sudo ./vpn-endpoint-route.sh install    — поставить и включить (без перезапуска сети)
#   sudo vpn-endpoint-route uninstall       — убрать всё
#   sudo vpn-endpoint-route up|down|refresh — включить / выключить / обновить шлюз
#   vpn-endpoint-route status               — состояние
# Список серверов: endpoints.txt рядом со скриптом → /etc/vpn-endpoint-route/endpoints.txt
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
BIN=/usr/local/sbin/vpn-endpoint-route
CONF_DIR=/etc/vpn-endpoint-route
NM_DISPATCH=/etc/NetworkManager/dispatcher.d/91-vpn-endpoint-route
UNIT=/etc/systemd/system/vpn-endpoint-route.service

TABLE=1518
PRIO=1518
# интерфейсы туннелей — их default/половинки не считаем провайдерским шлюзом
VPN_IFS="amn0 vpn0"

die() { echo "Ошибка: $*" >&2; exit 1; }
need_root() { [[ $EUID -eq 0 ]] || die "нужен root: sudo $0 $*"; }

endpoints() {
  local f="$CONF_DIR/endpoints.txt"
  [[ -f $f ]] || f="$SRC_DIR/endpoints.txt"
  grep -vE '^\s*(#|$)' "$f" | tr -d ' \t\r'
}

uplink() {
  ip -4 route show table main default | awk -v vpn=" $VPN_IFS " '
    { gw=""; dev=""; for (i=1;i<=NF;i++) { if ($i=="via") gw=$(i+1); if ($i=="dev") dev=$(i+1) }
      if (index(vpn, " " dev " ")==0 && gw!="") { print gw, dev; exit } }'
}

cmd_refresh() {
  local gw dev
  read -r gw dev < <(uplink) || true
  if [[ -z ${gw:-} ]]; then
    # нет сети — таблица пуста, правило проваливается в main, ничего не блокируется
    ip route flush table "$TABLE" 2>/dev/null || true
    echo "нет провайдерского шлюза — таблица $TABLE очищена"
    return 0
  fi
  ip route replace default via "$gw" dev "$dev" table "$TABLE"
}

cmd_up() {
  cmd_down_rules
  local ip
  for ip in $(endpoints); do
    ip rule add to "$ip/32" lookup "$TABLE" priority "$PRIO"
  done
  cmd_refresh
  echo "vpn-endpoint-route: включено ($(endpoints | paste -sd' '))"
}

cmd_down_rules() {
  while ip rule del priority "$PRIO" 2>/dev/null; do :; done
}

cmd_down() {
  cmd_down_rules
  ip route flush table "$TABLE" 2>/dev/null || true
  echo "vpn-endpoint-route: выключено"
}

cmd_install() {
  [[ -n $(endpoints) ]] || die "список серверов пуст: $SRC_DIR/endpoints.txt"
  install -Dm755 "$SRC_DIR/vpn-endpoint-route.sh" "$BIN"
  install -Dm644 "$SRC_DIR/endpoints.txt" "$CONF_DIR/endpoints.txt"

  cat > "$NM_DISPATCH" <<EOF
#!/bin/sh
# смена сети/шлюза — обновить маршрут до VPN-серверов
case "\$2" in up|dhcp4-change|connectivity-change) $BIN refresh ;; esac
EOF
  chmod 755 "$NM_DISPATCH"

  cat > "$UNIT" <<EOF
[Unit]
Description=Маршрут до VPN-серверов мимо туннеля (обход бага AmneziaVPN)
After=NetworkManager.service
Before=AmneziaVPN.service

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
  systemctl enable vpn-endpoint-route.service
  systemctl restart vpn-endpoint-route.service
  cmd_status
}

cmd_uninstall() {
  systemctl disable --now vpn-endpoint-route.service 2>/dev/null || true
  cmd_down
  rm -f "$UNIT" "$NM_DISPATCH" "$BIN"
  rm -rf "$CONF_DIR"
  systemctl daemon-reload
  echo "vpn-endpoint-route: удалено"
}

cmd_status() {
  echo "uplink: $(uplink)"
  ip rule show priority "$PRIO" | sed 's/^/rule:  /' || true
  # таблицы нет, пока не включено — ip route show вернёт ошибку
  { ip route show table "$TABLE" 2>/dev/null || true; } | sed 's/^/table: /'
  local ip
  for ip in $(endpoints); do echo "route: $(ip route get "$ip" | head -1)"; done
}

case "${1:-}" in
  install)   need_root install;   cmd_install ;;
  uninstall) need_root uninstall; cmd_uninstall ;;
  up)        need_root up;        cmd_up ;;
  down)      need_root down;      cmd_down ;;
  refresh)   need_root refresh;   cmd_refresh ;;
  status)    cmd_status ;;
  *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
