#!/usr/bin/env bash

set -Eeuo pipefail

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

APP_NAME="Auto CF"
APP_SLUG="auto-cf"
SERVICE_NAME="${SERVICE_NAME:-auto-cf}"
DEFAULT_INSTALL_PATH="/opt/auto_cf"
LEGACY_INSTALL_PATH="/opt/atuo-cf"
ENV_RECORD_FILE="/etc/auto_cf_path"
LEGACY_ENV_RECORD_FILE="/etc/atuo-cf_env"
SOURCE_REPO_URL="${SOURCE_REPO_URL:-https://github.com/nurohia/auto_cf.git}"
SOURCE_REPO_BRANCH="${SOURCE_REPO_BRANCH:-main}"
SCRIPT_RAW_URL="${SCRIPT_RAW_URL:-https://raw.githubusercontent.com/nurohia/auto_cf/${SOURCE_REPO_BRANCH}/deploy.sh}"
DEFAULT_WEB_PORT="${PORT:-5100}"
NODE_MAJOR="${NODE_MAJOR:-20}"
SKIP_CFST="${SKIP_CFST:-false}"
CFST_DOWNLOAD_URL="${CFST_DOWNLOAD_URL:-}"

if [[ -t 1 ]]; then
    GREEN="$(printf '\033[32m')"
    YELLOW="$(printf '\033[33m')"
    RED="$(printf '\033[31m')"
    BOLD="$(printf '\033[1m')"
    RESET="$(printf '\033[0m')"
else
    GREEN=""
    YELLOW=""
    RED=""
    BOLD=""
    RESET=""
fi

info() { printf '%s[INFO]%s %s\n' "${GREEN}" "${RESET}" "$1"; }
warn() { printf '%s[WARN]%s %s\n' "${YELLOW}" "${RESET}" "$1" >&2; }
err()  { printf '%s[ERROR]%s %s\n' "${RED}" "${RESET}" "$1" >&2; }
die()  { printf '%s[FATAL]%s %s\n' "${RED}" "${RESET}" "$1" >&2; exit 1; }

run_as_root() {
    if [[ "${EUID}" -eq 0 ]]; then
        return 1
    fi

    command -v sudo >/dev/null 2>&1 || die "需要 root 权限，但系统没有 sudo。请切换 root 后再运行。"
    info "该操作需要 root 权限，正在调用 sudo ..."

    if [[ -f "${BASH_SOURCE[0]}" && "${BASH_SOURCE[0]}" != /dev/fd/* ]]; then
        sudo env \
            APP_DIR="${APP_DIR:-}" \
            PORT="${PORT:-}" \
            SERVICE_NAME="${SERVICE_NAME}" \
            SOURCE_REPO_URL="${SOURCE_REPO_URL}" \
            SOURCE_REPO_BRANCH="${SOURCE_REPO_BRANCH}" \
            SCRIPT_RAW_URL="${SCRIPT_RAW_URL}" \
            SKIP_CFST="${SKIP_CFST}" \
            CFST_DOWNLOAD_URL="${CFST_DOWNLOAD_URL}" \
            bash "${BASH_SOURCE[0]}" "$@"
    else
        local script_body
        script_body="$(curl -fsSL "${SCRIPT_RAW_URL}")"
        sudo env \
            APP_DIR="${APP_DIR:-}" \
            PORT="${PORT:-}" \
            SERVICE_NAME="${SERVICE_NAME}" \
            SOURCE_REPO_URL="${SOURCE_REPO_URL}" \
            SOURCE_REPO_BRANCH="${SOURCE_REPO_BRANCH}" \
            SCRIPT_RAW_URL="${SCRIPT_RAW_URL}" \
            SKIP_CFST="${SKIP_CFST}" \
            CFST_DOWNLOAD_URL="${CFST_DOWNLOAD_URL}" \
            bash -c "${script_body}" deploy.sh "$@"
    fi
}

require_root() {
    if [[ "${EUID}" -ne 0 ]]; then
        run_as_root "$@"
        exit $?
    fi
}

require_debian() {
    [[ -f /etc/debian_version ]] || die "当前脚本仅支持 Debian / Ubuntu。"
}

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || die "系统缺少必要命令: $1"
}

get_local_ip() {
    hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1"
}

valid_port() {
    local port="$1"
    [[ "$port" =~ ^[0-9]+$ ]] && [[ "$port" -ge 1 ]] && [[ "$port" -le 65535 ]]
}

port_in_use() {
    local port="$1"
    if command -v ss >/dev/null 2>&1; then
        ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "(^|:)${port}$"
    elif command -v netstat >/dev/null 2>&1; then
        netstat -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "(^|:)${port}$"
    else
        return 1
    fi
}

find_free_port() {
    local port="$1"
    while [[ "$port" -le 65535 ]]; do
        if ! port_in_use "$port"; then
            echo "$port"
            return 0
        fi
        port=$((port + 1))
    done
    return 1
}

ask() {
    local prompt="$1"
    local default="${2:-}"
    local value

    if [[ -n "$default" ]]; then
        read -r -p "${prompt} [${default}]: " value
        echo "${value:-$default}"
    else
        read -r -p "${prompt}: " value
        echo "$value"
    fi
}

confirm_yes() {
    local prompt="$1"
    local answer
    read -r -p "${prompt} [y/N]: " answer
    [[ "${answer}" =~ ^([Yy]|[Yy][Ee][Ss])$ ]]
}

get_script_dir() {
    cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd
}

is_project_root() {
    [[ -f "$1/package.json" && -d "$1/server" && -d "$1/public" ]]
}

is_git_project_root() {
    is_project_root "$1" && [[ -d "$1/.git" ]]
}

find_project_root() {
    if [[ -n "${PROJECT_ROOT:-}" && -d "${PROJECT_ROOT}" ]] && is_project_root "${PROJECT_ROOT}"; then
        cd "${PROJECT_ROOT}" >/dev/null 2>&1 && pwd
        return 0
    fi

    local script_dir
    script_dir="$(get_script_dir)"
    if is_git_project_root "${script_dir}"; then
        echo "${script_dir}"
        return 0
    fi

    if is_git_project_root "$PWD"; then
        pwd
        return 0
    fi

    return 1
}

get_workdir() {
    if [[ -n "${APP_DIR:-}" ]]; then
        echo "${APP_DIR}"
        return
    fi

    if [[ -f "${ENV_RECORD_FILE}" ]]; then
        local recorded
        recorded="$(cat "${ENV_RECORD_FILE}" 2>/dev/null || true)"
        if [[ -n "${recorded}" && -d "${recorded}" ]]; then
            echo "${recorded}"
            return
        fi
    fi

    if [[ -d "${DEFAULT_INSTALL_PATH}" ]]; then
        echo "${DEFAULT_INSTALL_PATH}"
        return
    fi

    echo "${DEFAULT_INSTALL_PATH}"
}

get_installed_workdir() {
    local dir
    if [[ -n "${APP_DIR:-}" && -d "${APP_DIR}" ]]; then
        echo "${APP_DIR}"
        return
    fi

    if [[ -f "${ENV_RECORD_FILE}" ]]; then
        dir="$(cat "${ENV_RECORD_FILE}" 2>/dev/null || true)"
        if [[ -n "${dir}" && -d "${dir}" ]]; then
            echo "${dir}"
            return
        fi
    fi

    if [[ -d "${DEFAULT_INSTALL_PATH}" ]]; then
        echo "${DEFAULT_INSTALL_PATH}"
        return
    fi

    if [[ -d "${LEGACY_INSTALL_PATH}" ]]; then
        echo "${LEGACY_INSTALL_PATH}"
        return
    fi

    echo ""
}

safe_remove_dir() {
    local path="$1"
    local resolved

    [[ -n "$path" ]] || { err "删除路径为空，已取消。"; return 1; }
    resolved="$(readlink -f "$path" 2>/dev/null || realpath "$path" 2>/dev/null || echo "$path")"

    case "$resolved" in
        ""|"/"|"/bin"|"/boot"|"/dev"|"/etc"|"/home"|"/lib"|"/lib64"|"/opt"|"/proc"|"/root"|"/run"|"/sbin"|"/srv"|"/sys"|"/tmp"|"/usr"|"/var")
            err "拒绝删除危险路径: ${resolved}"
            return 1
        ;;
    esac

    rm -rf -- "$resolved"
}

install_base_packages() {
    info "安装基础依赖 ..."
    apt-get update
    apt-get install -y ca-certificates curl gnupg git rsync tar unzip openssl lsof
}

install_node() {
    if command -v node >/dev/null 2>&1; then
        local current_major
        current_major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
        if [[ "${current_major}" -ge "${NODE_MAJOR}" ]]; then
            info "Node.js 已就绪：$(node -v)"
            return
        fi
    fi

    info "安装 Node.js ${NODE_MAJOR} ..."
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key" \
        | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list
    apt-get update
    apt-get install -y nodejs
}

persist_script() {
    local workdir="$1"
    local target="${workdir}/deploy.sh"

    if [[ -f "${BASH_SOURCE[0]}" ]]; then
        cp "${BASH_SOURCE[0]}" "${target}" 2>/dev/null || true
    fi

    if [[ ! -s "${target}" ]] && command -v curl >/dev/null 2>&1; then
        curl -fsSL "${SCRIPT_RAW_URL}" -o "${target}" 2>/dev/null || true
    fi

    chmod +x "${target}" 2>/dev/null || true
}

sync_project_source() {
    local workdir="$1"
    local project_root=""

    mkdir -p "${workdir}" "${workdir}/bin" "${workdir}/.data"

    if project_root="$(find_project_root)"; then
        info "同步当前项目源码到 ${workdir} ..."
        rsync -a --delete \
            --exclude '.git' \
            --exclude '.data' \
            --exclude 'bin' \
            --exclude 'node_modules' \
            "${project_root}/" "${workdir}/"
    else
        require_cmd git
        info "从 ${SOURCE_REPO_URL} 拉取源码 ..."
        local tmp_dir
        tmp_dir="$(mktemp -d)"
        git clone --depth 1 --branch "${SOURCE_REPO_BRANCH}" "${SOURCE_REPO_URL}" "${tmp_dir}"
        rsync -a --delete \
            --exclude '.git' \
            --exclude '.data' \
            --exclude 'bin' \
            --exclude 'node_modules' \
            "${tmp_dir}/" "${workdir}/"
        rm -rf "${tmp_dir}"
    fi

    chmod 700 "${workdir}/.data"
    [[ -f "${workdir}/bin/cfst" ]] && chmod +x "${workdir}/bin/cfst"
    persist_script "${workdir}"
}

detect_port() {
    local service_file="/etc/systemd/system/${SERVICE_NAME}.service"
    if [[ -f "${service_file}" ]]; then
        local found
        found="$(grep -E '^Environment=PORT=' "${service_file}" | tail -n 1 | cut -d= -f3- || true)"
        if valid_port "${found:-}"; then
            echo "${found}"
            return
        fi
    fi
    echo "${DEFAULT_WEB_PORT}"
}

write_service() {
    local workdir="$1"
    local port="$2"
    local npm_bin
    npm_bin="$(command -v npm || echo /usr/bin/npm)"

    info "写入 systemd 服务：${SERVICE_NAME}.service"
    cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Auto CF CloudflareSpeedTest Panel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${workdir}
Environment=NODE_ENV=production
Environment=PORT=${port}
Environment=CFST_BIN=${workdir}/bin/cfst
Environment=APP_PASSWORD_FILE=${workdir}/.data/admin-password
ExecStart=${npm_bin} run start
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable "${SERVICE_NAME}" >/dev/null
}

ensure_admin_password() {
    local workdir="$1"
    local password_file="${workdir}/.data/admin-password"
    mkdir -p "${workdir}/.data"
    chmod 700 "${workdir}/.data"

    if [[ ! -s "${password_file}" ]]; then
        openssl rand -base64 18 > "${password_file}"
        chmod 600 "${password_file}"
    fi
}

reset_admin_password() {
    require_root "$@"
    local workdir
    workdir="$(get_workdir)"
    [[ -d "${workdir}" ]] || die "未找到安装目录，请先运行安装。"

    local password_file="${workdir}/.data/admin-password"
    mkdir -p "${workdir}/.data"
    chmod 700 "${workdir}/.data"
    openssl rand -base64 18 > "${password_file}"
    chmod 600 "${password_file}"
    systemctl restart "${SERVICE_NAME}" 2>/dev/null || true

    cat <<EOF

${GREEN}管理员密码已重置。${RESET}

新密码：
  $(cat "${password_file}")

密码文件：
  ${password_file}

EOF
}

start_service() {
    systemctl restart "${SERVICE_NAME}"
}

download_cfst() {
    local workdir="$1"
    local arch
    arch="$(uname -m)"
    case "${arch}" in
        x86_64|amd64) arch="amd64" ;;
        aarch64|arm64) arch="arm64" ;;
        *) die "暂不支持自动下载这个架构的 CloudflareSpeedTest：${arch}" ;;
    esac

    require_cmd curl
    require_cmd node

    local tmp
    tmp="$(mktemp -d)"
    local asset_url
    if [[ -n "${CFST_DOWNLOAD_URL}" ]]; then
        asset_url="${CFST_DOWNLOAD_URL}"
    else
        info "下载 CloudflareSpeedTest latest release ..."
        curl -fsSL "https://api.github.com/repos/XIU2/CloudflareSpeedTest/releases/latest" -o "${tmp}/release.json"
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
")" || die "没有找到 linux-${arch} 的 CloudflareSpeedTest release 包"
    fi

    curl -fL "${asset_url}" -o "${tmp}/cfst.pkg"
    mkdir -p "${tmp}/extract" "${workdir}/bin"
    if [[ "${asset_url}" == *.zip ]]; then
        unzip -q "${tmp}/cfst.pkg" -d "${tmp}/extract"
    else
        tar -xzf "${tmp}/cfst.pkg" -C "${tmp}/extract"
    fi

    local binary
    binary="$(find "${tmp}/extract" -type f \( -name 'cfst' -o -name 'CloudflareSpeedTest' \) | head -n 1)"
    [[ -n "${binary}" ]] || die "下载包里没有找到 CloudflareSpeedTest 可执行文件"
    install -m 0755 "${binary}" "${workdir}/bin/cfst"
    find "${tmp}/extract" -maxdepth 2 -type f -name '*.txt' -exec install -m 0644 {} "${workdir}/bin/" \;
    [[ -f "${workdir}/bin/ip.txt" ]] || die "下载包里没有找到 ip.txt"
    [[ -f "${workdir}/bin/ipv6.txt" ]] || warn "下载包里没有找到 ipv6.txt，AAAA 快查/任务可能不可用。"
    rm -rf "${tmp}"
    info "CloudflareSpeedTest 已安装到 ${workdir}/bin/cfst"
}

ensure_cfst() {
    local workdir="$1"

    if [[ -x "${workdir}/bin/cfst" && -f "${workdir}/bin/ip.txt" ]]; then
        info "CloudflareSpeedTest 已就绪：${workdir}/bin/cfst"
        return
    fi

    if [[ "${SKIP_CFST}" == "true" ]]; then
        warn "已按 SKIP_CFST=true 跳过 CloudflareSpeedTest 安装。"
        return
    fi

    download_cfst "${workdir}"
}

show_success() {
    local workdir="$1"
    local port="$2"
    local ip
    ip="$(get_local_ip)"
    cat <<EOF

${GREEN}部署完成。${RESET}

访问地址：
  http://${ip}:${port}
  http://服务器IP:${port}

安装目录：
  ${workdir}

管理员密码：
  $(cat "${workdir}/.data/admin-password" 2>/dev/null || echo "请查看 ${workdir}/.data/admin-password")

常用命令：
  cd ${workdir} && sudo bash deploy.sh
  sudo bash ${workdir}/deploy.sh update
  sudo bash ${workdir}/deploy.sh install-cfst
  sudo bash ${workdir}/deploy.sh logs

EOF
}

install_app() {
    require_root "$@"
    require_debian
    install_base_packages
    install_node

    local workdir="${APP_DIR:-${DEFAULT_INSTALL_PATH}}"
    if [[ -t 0 && -z "${APP_DIR:-}" ]]; then
        workdir="$(ask "请输入安装目录" "${DEFAULT_INSTALL_PATH}")"
    fi

    local port="${PORT:-${DEFAULT_WEB_PORT}}"
    if [[ -t 0 && -z "${PORT:-}" ]]; then
        local suggested
        suggested="$(find_free_port "${DEFAULT_WEB_PORT}" || echo "${DEFAULT_WEB_PORT}")"
        port="$(ask "请输入 Web 端口" "${suggested}")"
        valid_port "${port}" || die "端口无效：${port}"
    fi

    mkdir -p "${workdir}"
    echo "${workdir}" > "${ENV_RECORD_FILE}"
    sync_project_source "${workdir}"
    ensure_admin_password "${workdir}"
    write_service "${workdir}" "${port}"

    ensure_cfst "${workdir}"

    start_service
    show_success "${workdir}" "${port}"
}

update_app() {
    require_root "$@"
    require_debian
    install_base_packages
    install_node

    local workdir
    workdir="$(get_workdir)"
    [[ -d "${workdir}" ]] || die "未找到安装目录，请先运行 install。"

    local port
    port="$(detect_port)"
    echo "${workdir}" > "${ENV_RECORD_FILE}"
    sync_project_source "${workdir}"
    ensure_admin_password "${workdir}"
    ensure_cfst "${workdir}"
    write_service "${workdir}" "${port}"
    start_service
    info "更新完成。"
}

install_cfst_action() {
    require_root "$@"
    require_debian
    install_base_packages
    install_node

    local workdir
    workdir="$(get_workdir)"
    [[ -d "${workdir}" ]] || die "未找到安装目录，请先运行 install。"
    download_cfst "${workdir}"
    systemctl restart "${SERVICE_NAME}" 2>/dev/null || true
}

restart_app() {
    require_root "$@"
    systemctl restart "${SERVICE_NAME}"
    info "已重启。"
}

show_status() {
    systemctl --no-pager --full status "${SERVICE_NAME}" || true
}

show_logs() {
    journalctl -u "${SERVICE_NAME}" -f
}

uninstall_app() {
    require_root "$@"

    local workdir
    workdir="$(get_installed_workdir)"

    warn "即将卸载 ${APP_NAME}"
    warn "服务：${SERVICE_NAME}"
    warn "目录：${workdir:-未发现安装目录}"

    if [[ -t 0 ]]; then
        if ! confirm_yes "确认卸载并删除服务、源码和数据？"; then
            warn "已取消卸载。"
            return 1
        fi
    elif [[ "${AUTO_CF_CONFIRM_UNINSTALL:-}" != "y" ]]; then
        die "非交互环境不会直接卸载。确认要卸载请设置 AUTO_CF_CONFIRM_UNINSTALL=y。"
    fi

    for service in "${SERVICE_NAME}" "auto-cf" "atuo-cf"; do
        systemctl stop "${service}" 2>/dev/null || true
        systemctl disable "${service}" >/dev/null 2>&1 || true
        rm -f "/etc/systemd/system/${service}.service"
    done
    systemctl daemon-reload 2>/dev/null || true
    if [[ -n "${workdir}" ]]; then
        safe_remove_dir "${workdir}"
    fi
    if [[ "${workdir}" != "${DEFAULT_INSTALL_PATH}" ]]; then
        safe_remove_dir "${DEFAULT_INSTALL_PATH}" 2>/dev/null || true
    fi
    if [[ "${workdir}" != "${LEGACY_INSTALL_PATH}" ]]; then
        safe_remove_dir "${LEGACY_INSTALL_PATH}" 2>/dev/null || true
    fi
    rm -f "${ENV_RECORD_FILE}"
    rm -f "${LEGACY_ENV_RECORD_FILE}"
    info "卸载完成。"
}

print_usage() {
    cat <<EOF
${APP_NAME} 一键部署脚本

用法：
  bash deploy.sh install             安装
  bash deploy.sh update              更新并重启
  bash deploy.sh restart             重启服务
  bash deploy.sh reset-password      重置管理员密码
  bash deploy.sh status              查看状态
  bash deploy.sh logs                查看日志
  bash deploy.sh uninstall           卸载
  bash deploy.sh menu                打开菜单

远程安装：
  bash <(curl -fsSL ${SCRIPT_RAW_URL})

可选环境变量：
  APP_DIR=/opt/auto_cf PORT=5100 SERVICE_NAME=auto-cf SOURCE_REPO_BRANCH=main SKIP_CFST=false
  CFST_DOWNLOAD_URL=https://example.com/CloudflareSpeedTest.tar.gz
EOF
}

show_menu() {
    while true; do
        local installed_dir display_dir
        installed_dir="$(get_installed_workdir)"
        display_dir="${installed_dir:-未安装}"
        if [[ -t 1 ]]; then
            clear || true
        fi
        printf '%s%s 控制台%s\n' "${BOLD}${GREEN}" "${APP_NAME}" "${RESET}"
        printf '%s\n\n' '----------------'
        printf '安装目录  %s\n' "${display_dir}"
        printf '服务名称  %s\n\n' "${SERVICE_NAME}"
        printf '[1] 安装 / 重装\n'
        printf '[2] 更新项目\n'
        printf '[3] 重启服务\n'
        printf '[4] 重置管理员密码\n'
        printf '[5] 查看状态\n'
        printf '[6] 查看日志\n'
        printf '[7] 卸载\n'
        printf '[0] 退出\n\n'
        local choice
        read -r -p "请选择 [0-7]: " choice
        case "${choice}" in
            1) install_app install ;;
            2) update_app update ;;
            3) restart_app restart ;;
            4) reset_admin_password reset-password ;;
            5) show_status ;;
            6) show_logs ;;
            7) uninstall_app uninstall && exit 0 ;;
            0) exit 0 ;;
            *) warn "无效选择。" ;;
        esac
        echo
        read -r -p "回车返回菜单..." _
    done
}

main() {
    local action="${1:-menu}"
    case "${action}" in
        install) install_app "$@" ;;
        update) update_app "$@" ;;
        install-cfst|cfst) install_cfst_action "$@" ;;
        restart) restart_app "$@" ;;
        reset-password|password) reset_admin_password "$@" ;;
        status) show_status ;;
        logs) show_logs ;;
        uninstall|remove) uninstall_app "$@" ;;
        menu) show_menu ;;
        help|-h|--help) print_usage ;;
        *) print_usage ;;
    esac
}

main "$@"
