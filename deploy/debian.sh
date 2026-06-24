#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="${APP_NAME:-atuo-cf}"
APP_DIR="${APP_DIR:-/opt/${APP_NAME}}"
SERVICE_NAME="${SERVICE_NAME:-${APP_NAME}}"
PORT="${PORT:-5100}"
NODE_MAJOR="${NODE_MAJOR:-20}"
CFST_BIN="${CFST_BIN:-${APP_DIR}/bin/cfst}"
ACTION="${1:-install}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
SRC_DIR="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"

log() {
  printf '\033[1;32m[%s]\033[0m %s\n' "${APP_NAME}" "$*"
}

warn() {
  printf '\033[1;33m[%s]\033[0m %s\n' "${APP_NAME}" "$*"
}

die() {
  printf '\033[1;31m[%s]\033[0m %s\n' "${APP_NAME}" "$*" >&2
  exit 1
}

need_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    die "请使用 root 运行：sudo bash deploy/debian.sh ${ACTION}"
  fi
}

ensure_debian() {
  if [[ ! -f /etc/debian_version ]]; then
    die "这个脚本只面向 Debian / Ubuntu 系统"
  fi
}

install_base_packages() {
  log "安装基础依赖"
  apt-get update
  apt-get install -y ca-certificates curl gnupg rsync tar unzip
}

install_node() {
  if command -v node >/dev/null 2>&1; then
    local current_major
    current_major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
    if [[ "${current_major}" -ge "${NODE_MAJOR}" ]]; then
      log "Node.js 已就绪：$(node -v)"
      return
    fi
  fi

  log "安装 Node.js ${NODE_MAJOR}"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key" \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt-get install -y nodejs
}

sync_app() {
  log "同步项目到 ${APP_DIR}"
  mkdir -p "${APP_DIR}" "${APP_DIR}/bin" "${APP_DIR}/.data"
  rsync -a --delete \
    --exclude '.git' \
    --exclude '.data' \
    --exclude 'node_modules' \
    "${SRC_DIR}/" "${APP_DIR}/"

  chmod 700 "${APP_DIR}/.data"
  if [[ -f "${APP_DIR}/bin/cfst" ]]; then
    chmod +x "${APP_DIR}/bin/cfst"
  fi
}

write_service() {
  log "写入 systemd 服务 ${SERVICE_NAME}.service"
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Atuo CF CloudflareSpeedTest Panel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=PORT=${PORT}
Environment=CFST_BIN=${CFST_BIN}
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}" >/dev/null
}

start_service() {
  log "启动服务"
  systemctl restart "${SERVICE_NAME}"
  systemctl --no-pager --full status "${SERVICE_NAME}" || true
}

download_cfst() {
  local arch
  arch="$(uname -m)"
  case "${arch}" in
    x86_64 | amd64) arch="amd64" ;;
    aarch64 | arm64) arch="arm64" ;;
    *) die "暂不支持自动下载这个架构的 CFST：${arch}" ;;
  esac

  local tmp
  tmp="$(mktemp -d)"
  log "下载 CloudflareSpeedTest latest release"
  curl -fsSL "https://api.github.com/repos/XIU2/CloudflareSpeedTest/releases/latest" -o "${tmp}/release.json"

  local asset_url
  asset_url="$(node -e "
const fs = require('fs');
const release = JSON.parse(fs.readFileSync('${tmp}/release.json', 'utf8'));
const asset = release.assets.find(item =>
  /linux/i.test(item.name) &&
  /${arch}/i.test(item.name) &&
  /\\.(tar\\.gz|zip)$/i.test(item.name)
);
if (!asset) process.exit(1);
console.log(asset.browser_download_url);
")" || die "没有找到适合 linux-${arch} 的 CFST release 包"

  curl -fL "${asset_url}" -o "${tmp}/cfst.pkg"
  mkdir -p "${tmp}/extract" "${APP_DIR}/bin"
  if [[ "${asset_url}" == *.zip ]]; then
    unzip -q "${tmp}/cfst.pkg" -d "${tmp}/extract"
  else
    tar -xzf "${tmp}/cfst.pkg" -C "${tmp}/extract"
  fi

  local binary
  binary="$(find "${tmp}/extract" -type f \( -name 'cfst' -o -name 'CloudflareSpeedTest' \) | head -n 1)"
  [[ -n "${binary}" ]] || die "下载包里没有找到 CFST 可执行文件"
  install -m 0755 "${binary}" "${APP_DIR}/bin/cfst"
  rm -rf "${tmp}"
  log "CFST 已安装到 ${APP_DIR}/bin/cfst"
}

show_info() {
  cat <<EOF

部署完成。

访问地址：
  http://服务器IP:${PORT}

常用命令：
  systemctl status ${SERVICE_NAME}
  journalctl -u ${SERVICE_NAME} -f
  bash deploy/debian.sh update
  bash deploy/debian.sh install-cfst

CFST 路径：
  ${APP_DIR}/bin/cfst

EOF
}

install_app() {
  need_root
  ensure_debian
  install_base_packages
  install_node
  sync_app
  write_service
  start_service
  show_info
}

update_app() {
  need_root
  ensure_debian
  sync_app
  write_service
  start_service
}

case "${ACTION}" in
  install)
    install_app
    ;;
  update)
    update_app
    ;;
  restart)
    need_root
    systemctl restart "${SERVICE_NAME}"
    ;;
  status)
    systemctl --no-pager --full status "${SERVICE_NAME}"
    ;;
  logs)
    journalctl -u "${SERVICE_NAME}" -f
    ;;
  install-cfst)
    need_root
    ensure_debian
    install_base_packages
    sync_app
    download_cfst
    systemctl restart "${SERVICE_NAME}" || true
    ;;
  *)
    cat <<EOF
用法：
  sudo bash deploy/debian.sh install       安装/重装
  sudo bash deploy/debian.sh update        更新代码并重启
  sudo bash deploy/debian.sh install-cfst  自动下载 CFST
  sudo bash deploy/debian.sh restart       重启服务
  bash deploy/debian.sh status             查看状态
  bash deploy/debian.sh logs               查看日志

可选环境变量：
  APP_DIR=/opt/atuo-cf PORT=5100 SERVICE_NAME=atuo-cf
EOF
    ;;
esac
