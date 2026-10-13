#!/usr/bin/env bash
#
# 构建精简版 ffmpeg —— 仅含 MP4 录制所需的组件
#
# 【为什么需要这个脚本】
# 视频录制（H.264 MP4）通过 ffmpeg 子进程 pipe 编码，实际只用得到这一条链路：
#
#   rawvideo 解码 → libx264 编码 → mp4/mov 封装 → crop 滤镜 → fd/file/pipe 协议
#
# 官方 full build（gyan.dev、BtbN 等）约 230MB，其余编解码器全部闲置。本脚本从源码
# 构建只含该链路的版本（约 4MB），安装包因此由 92MB 降至 37MB。
#
# 【换 ffmpeg / x264 版本后必须重新验证】
# 用与 recording/video_encoder.rs 相同的命令行，分别跑 full build 与本精简版：
#
#   <ff> -y -loglevel error -f rawvideo -pix_fmt bgra -s 320x240 -r 15 -i - \
#        -c:v libx264 -preset ultrafast -crf 23 \
#        -vf "crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0" \
#        -pix_fmt yuv420p -movflags +faststart out.mp4 < frames.bgra
#
#   <官方 full build> -i full.mp4 -i lite.mp4 -lavfi psnr -f null -   # average:inf = 逐像素完全一致
#
#   ↑ 这条比对**必须用官方 full build 执行**：精简版没有 mp4 解码器、没有 psnr 滤镜，
#     拿它跑只会得到 "No such filter: 'psnr'"。
#
# 另外核对：帧数是否一致；ftyp/moov/mdat 的 box 顺序是否一致（faststart 生效）；
# 奇数尺寸是否被 crop 正确裁成偶数。最后跑项目的 `cargo test video_encoder`，但注意：
#   ① 该测试找不到 ffmpeg 时会**静默 return**（仍算通过），务必先 `--install` 再跑；
#   ② `ffmpeg_path()` 找不到仓库内二进制时会退化为 `PathBuf::from("ffmpeg")`，由
#      CreateProcess 走 PATH 解析 —— 于是它可能在验证 PATH 上任意一份 ffmpeg。
#      同样靠"先 --install"规避。开发机 PATH 上有 Git/WinLibs 的 mingw64\bin，
#      这让两个真实缺陷（漏 fd 协议、依赖 libwinpthread）都从这条测试底下溜了过去。
#
# 【本构建不保证 bit 级可复现】
# 并行编译的链接顺序会影响二进制内部布局，configure 参数的先后也会原样写进
# `ffmpeg -version` 的 configuration 行，所以重复构建的文件哈希可能不同
# （实测：文件大小相同，约 400 字节差异，差异来源即参数顺序与链接布局）。
# 判定两份构建是否等价，请用上面的 PSNR 比对 + cargo test，不要比对哈希。
#
# 【依赖】
# x86_64-w64-mingw32 工具链：gcc、make（或 mingw32-make）、nasm。
# Windows 下推荐 WinLibs，一次装齐（含 nasm 与 mingw32-make）：
#
#   winget install BrechtSanders.WinLibs.POSIX.UCRT
#
# 【用法】
#   ./scripts/build-ffmpeg-lite.sh              # 构建到 $BUILD_DIR
#   ./scripts/build-ffmpeg-lite.sh --install    # 构建后覆盖 src-tauri/binaries/ffmpeg.exe
#
# 可重复运行：已下载的源码、已构建的 x264、已解压的源码树都会跳过。参数没变时
# configure 不会重写 config.h（它用 cp_if_changed 写入），make 近乎空转；一旦改了参数，
# config.h 里的 FFMPEG_CONFIGURATION 字符串随之改变，就会触发全量重编 —— 所以不存在
# "改了参数却被静默跳过、拿到与脚本不符的产物"这种情况。（实测全量重编约 1 分钟量级。）
#
# 环境变量：
#   BUILD_DIR        构建目录，默认 /d/tmp/ffmpeg-lite-build
#   FFMPEG_VERSION   ffmpeg 版本，默认 8.1.2（改了会触发全量重编）
#   HTTP_PROXY_URL   源码下载走代理，如 http://127.0.0.1:10808
#                    （ffmpeg.org / code.videolan.org 直连通常够用，GitHub 才需要）
#
set -euo pipefail

FFMPEG_VERSION="${FFMPEG_VERSION:-8.1.2}"
X264_URL="https://code.videolan.org/videolan/x264/-/archive/stable/x264-stable.tar.gz"
FFMPEG_URL="https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 脚本自身的绝对路径与原始参数：失败提示里要能让用户直接照抄重跑。
# 注意不能用 $0 / $* —— 在函数体里它们是**函数的**位置参数，照抄会丢掉 --install。
SCRIPT_SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
SCRIPT_ARGS=("$@")
BUILD_DIR="${BUILD_DIR:-/d/tmp/ffmpeg-lite-build}"
INSTALL=0
case "${1:-}" in
  "")        ;;
  --install) INSTALL=1 ;;
  *) echo "未知参数：$1（本脚本只支持 --install）" >&2; exit 1 ;;
esac

log() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

# Git Bash 下 configure 会把 Windows 的临时目录（C:\Users\...）当 TMPDIR，反斜杠在
# shell 里被吞掉，报 "Unable to create and execute files in C:\Users..." 而失败。
# 指向一个纯 Unix 风格目录即可绕开。
export TMPDIR="$BUILD_DIR/tmp"
mkdir -p "$TMPDIR" "$BUILD_DIR/bin"

# 传给 gcc / configure 的路径必须是 Windows 可识别的形式（经 MSYS 转换容易出错），
# 显式转成 D:/tmp/... 混合风格，本脚本内部的文件操作用 Unix 风格。
if command -v cygpath >/dev/null 2>&1; then
  BUILD_DIR_WIN="$(cygpath -m "$BUILD_DIR")"
else
  BUILD_DIR_WIN="$BUILD_DIR"
fi

# -f：HTTP 错误码（404/500）直接判失败。否则 curl 会把错误页写进目标文件、
#     还返回成功，而后续提示会把 404 说成"下载中断"，让用户陷入删了重下还是坏的循环。
# --connect-timeout：连接被防火墙丢包时快速失败，不必等满 --max-time。
# --max-time 900：相当于约 12 KB/s 的下限；比这更慢的链路会中途失败，而失败时会清掉
#     半截文件、重跑同样结果，因此慢速链路应换镜像源或走 HTTP_PROXY_URL。
# --retry：网络抖动自动重试。
CURL_OPTS=(-fsSL --connect-timeout 15 --max-time 900 --retry 3 --retry-delay 2)
if [ -n "${HTTP_PROXY_URL:-}" ]; then CURL_OPTS+=(-x "$HTTP_PROXY_URL"); fi

# 下载失败要给出可定位的信息，并清掉半截文件（否则下次运行会被当成"已下载"直接跳过）
download() { # $1=url $2=目标文件
  if ! curl "${CURL_OPTS[@]}" -o "$2" "$1"; then
    echo "下载失败：$1" >&2
    echo "  常见原因：网络不可达 / 该地址 404（版本号写错）/ 需要代理" >&2
    echo "  需要代理时：HTTP_PROXY_URL=http://127.0.0.1:10808 \"$SCRIPT_SELF\" ${SCRIPT_ARGS[*]:-}" >&2
    rm -f "$2"
    exit 1
  fi
}

JOBS="$( (nproc 2>/dev/null || echo 8) )"

# ── 1. 工具链检查 ────────────────────────────────────────────────
log "检查工具链"
for tool in gcc nasm tar xz curl objdump; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "缺少 $tool。请先安装 x86_64-w64-mingw32 工具链（WinLibs 自带 objdump）与 tar/xz/curl。" >&2
    exit 1
  fi
done
# gcc 必须是 mingw-w64 目标：若 PATH 上 MSYS 的 gcc 被优先命中，产出的 ffmpeg 会依赖
# msys-2.0.dll —— 在 Git Bash 里能跑，到端用户机器上却起不来（同 libwinpthread 那类事故）
GCC_TARGET="$(gcc -dumpmachine 2>/dev/null || echo unknown)"
case "$GCC_TARGET" in
  *w64-mingw32*) ;;
  *) echo "gcc 的目标平台是 $GCC_TARGET，需要 x86_64-w64-mingw32（当前 PATH 可能命中了 MSYS 的 gcc）" >&2; exit 1 ;;
esac
MAKE="$(command -v mingw32-make || command -v make || true)"
if [ -z "$MAKE" ]; then echo "缺少 make / mingw32-make" >&2; exit 1; fi
# `|| true` 兜住 pipefail：head 提前退出时上游可能收到 SIGPIPE 而以非零码结束
GCC_VERSION="$(gcc --version 2>&1 | head -1 || true)"
echo "  $GCC_VERSION"
echo "  make: $MAKE   jobs: $JOBS"

# ── 2. 下载源码 ──────────────────────────────────────────────────
cd "$BUILD_DIR"
if [ ! -f x264-stable.tar.gz ]; then
  log "下载 x264 源码"
  download "$X264_URL" x264-stable.tar.gz
fi
# 与下面 ffmpeg 的 `xz -t` 对称：下载中断的包若不在这里拦下，
# 会拖到解压或 configure 阶段才报错，错误信息与真实原因相距很远
if ! tar tzf x264-stable.tar.gz >/dev/null 2>&1; then
  echo "x264 源码包不完整（可能是下载中断），删除后重跑：" >&2
  echo "  rm $BUILD_DIR/x264-stable.tar.gz" >&2
  exit 1
fi
if [ ! -f "ffmpeg-${FFMPEG_VERSION}.tar.xz" ]; then
  log "下载 ffmpeg ${FFMPEG_VERSION} 源码"
  download "$FFMPEG_URL" "ffmpeg-${FFMPEG_VERSION}.tar.xz"
fi
if ! xz -t "ffmpeg-${FFMPEG_VERSION}.tar.xz" 2>/dev/null; then
  echo "ffmpeg 源码包不完整（可能是下载中断），删除后重跑：" >&2
  echo "  rm $BUILD_DIR/ffmpeg-${FFMPEG_VERSION}.tar.xz" >&2
  exit 1
fi

# ── 3. 构建 x264 静态库 ──────────────────────────────────────────
# 同时校验静态库与头文件：若上次构建中断在 make install 中途，只判库文件存在
# 会把一次残缺安装当成已完成，后续 configure 因缺 x264.h 失败且原因难辨
if [ ! -f x264-install/lib/libx264.a ] || [ ! -f x264-install/include/x264.h ]; then
  log "构建 x264"
  # 用标记文件判断"已解压"，而不是判断目录是否存在：解压中途被 Ctrl-C 会留下
  # 半个源码树，只判目录会让残缺树进入 configure / make，报出与真实原因无关的错误
  if [ ! -f x264-stable/.extract-ok ]; then
    rm -rf x264-stable
    tar xzf x264-stable.tar.gz
    touch x264-stable/.extract-ok
  fi
  cd x264-stable
  ./configure --host=x86_64-w64-mingw32 --enable-static --disable-cli --disable-opencl \
              --prefix="$BUILD_DIR_WIN/x264-install"
  "$MAKE" -j"$JOBS"
  "$MAKE" install
  cd "$BUILD_DIR"
else
  # x264 的源码包取自 stable 分支归档（内容会随时间变化），而缓存只判"文件是否存在"。
  # 想换 x264 版本必须连源码包一起删，否则新版本永远取不回来。
  log "x264 已构建，跳过（删 $BUILD_DIR/x264-install 可强制重建；换 x264 版本还需一并删 $BUILD_DIR/x264-stable.tar.gz 与 x264-stable/）"
fi

# ── 4. pkg-config 替身 ───────────────────────────────────────────
# 说明：即使系统已装 pkg-config 也一律使用本替身 —— 系统 pkg-config 还需要额外的
# PKG_CONFIG_PATH 才能找到 x264.pc（该路径在 MSYS 环境下还容易被转换出错），
# 而本次构建只有一个外部库，替身既确定又省掉这项依赖。
log "生成 pkg-config 替身"
cat > "$BUILD_DIR/bin/pkg-config" <<'PKGCONFIG'
#!/bin/bash
# 最小 pkg-config 替身：本构建只依赖 libx264，直接返回其编译/链接参数。
X264_CFLAGS="-I@X264_INC@"
X264_LIBS="-L@X264_LIB@ -lx264 -lpthread"

want_cflags=0; want_libs=0; want_exists=0; want_modver=0
for arg in "$@"; do
  case "$arg" in
    --cflags)     want_cflags=1 ;;
    --libs)       want_libs=1 ;;
    --exists)     want_exists=1 ;;
    --modversion) want_modver=1 ;;
  esac
done

[ $want_exists -eq 1 ] && exit 0
# 版本号只是占位：本 ffmpeg 的 configure 用 C 预处理条件（X264_BUILD）做版本门，
# 不走 pkg-config 的 --modversion，这个值不会被当真
[ $want_modver -eq 1 ] && { echo "0.164.0"; exit 0; }

out=""
[ $want_cflags -eq 1 ] && out="$X264_CFLAGS"
[ $want_libs -eq 1 ] && out="$out $X264_LIBS"
echo "$out"
exit 0
PKGCONFIG
sed -i "s|@X264_INC@|$BUILD_DIR_WIN/x264-install/include|" "$BUILD_DIR/bin/pkg-config"
sed -i "s|@X264_LIB@|$BUILD_DIR_WIN/x264-install/lib|" "$BUILD_DIR/bin/pkg-config"
chmod +x "$BUILD_DIR/bin/pkg-config"
# 置于 PATH 最前，确保 configure 取到的是替身而非系统同名的 pkg-config
export PATH="$BUILD_DIR/bin:$PATH"
if "$BUILD_DIR/bin/pkg-config" --exists x264; then
  echo "  替身自检通过"
else
  echo "  pkg-config 替身自检失败，请检查 $BUILD_DIR/bin/pkg-config" >&2
  exit 1
fi

# ── 5. configure ffmpeg ──────────────────────────────────────────
# 组件集由 recording/video_encoder.rs 的实际命令行反推，每一项都不可少：
#   libx264               → -c:v libx264
#   rawvideo 解码/解复用  → -f rawvideo -pix_fmt bgra -i -
#   mp4 / mov 封装        → 输出 .mp4 与 -movflags +faststart
#   crop 滤镜             → -vf crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0
#   swscale               → bgra → yuv420p 色彩转换
#   fd 协议               → -i - 读 stdin
#     ⚠ 漏掉 fd 会让录制直接失败：Error opening input: Protocol not found
#       （ffmpeg 对 -i - 的解析经 fd 协议，file/pipe 都不能替代）
#   file 协议             → 写输出文件
#   pipe 协议             → fd 在部分路径下的依赖
log "configure ffmpeg ${FFMPEG_VERSION}"
if [ ! -f "ffmpeg-${FFMPEG_VERSION}/.extract-ok" ]; then
  rm -rf "ffmpeg-${FFMPEG_VERSION}"
  tar xJf "ffmpeg-${FFMPEG_VERSION}.tar.xz"
  touch "ffmpeg-${FFMPEG_VERSION}/.extract-ok"
fi
cd "ffmpeg-${FFMPEG_VERSION}"
./configure \
  --prefix="$BUILD_DIR_WIN/ffmpeg-out" \
  --enable-static --disable-shared \
  --disable-everything \
  --enable-gpl \
  --enable-libx264 \
  --enable-encoder=libx264 \
  --enable-decoder=rawvideo \
  --enable-demuxer=rawvideo \
  --enable-muxer=mp4 \
  --enable-muxer=mov \
  --enable-filter=crop \
  --enable-filter=scale \
  --enable-filter=format \
  --enable-protocol=fd \
  --enable-protocol=file \
  --enable-protocol=pipe \
  --enable-swscale \
  --enable-ffmpeg \
  --disable-ffplay \
  --disable-ffprobe \
  --disable-network \
  --disable-autodetect \
  --disable-doc \
  --enable-small \
  --extra-cflags="-I$BUILD_DIR_WIN/x264-install/include" \
  --extra-ldflags="-L$BUILD_DIR_WIN/x264-install/lib -static" \
  --extra-libs="-lx264 -lpthread"

# ── 6. 编译 ──────────────────────────────────────────────────────
log "编译 ffmpeg（全量约 1~3 分钟）"
"$MAKE" -j"$JOBS"
ls -lh ffmpeg.exe

# 自检必须能**让脚本失败**。早期版本只 echo，组件缺失时会静默打印"完成"——
# 一个看起来像通过的检查比没有检查更危险。
log "产物自检"

# 1) DLL 依赖放在最前：产物加载不起来时，"协议/编码器"这些查询都会失败，
#    先报 DLL 才能给出真正的原因，而不是让用户看到脚本莫名退出
DLLS="$(objdump -p ffmpeg.exe 2>/dev/null | awk '/DLL Name/ {print $3}')"
if [ -z "$DLLS" ]; then
  echo "  ❌ 读不到 ffmpeg.exe 的导入表（objdump 不可用或产物损坏），无法确认它不依赖非系统 DLL" >&2
  exit 1
fi
# 按前缀匹配，而不是只盯已知的几个名字：lib*/msys-*/zlib/iconv/ssl 这类第三方库一旦被
# 动态引入，端用户机器上就没有。开发机的 PATH 上这些库都在，所以本地测试发现不了。
NON_SYS_DLLS="$(printf '%s\n' "$DLLS" \
  | grep -iE '^(lib|msys-|zlib|iconv|charset|pcre|ffi|expat|bz2|lzma|zstd|ssl|crypto)' || true)"
if [ -n "$NON_SYS_DLLS" ]; then
  echo "  ❌ 产物依赖了非系统 DLL，端用户机器上会启动失败：" >&2
  echo "$NON_SYS_DLLS" | sed 's/^/      /' >&2
  echo "     请确认 configure 的 --extra-ldflags 里包含 -static" >&2
  exit 1
fi
echo "  DLL 依赖：仅系统库 ✓（共 $(printf '%s\n' "$DLLS" | wc -l | tr -d ' ') 项）"

# 2) 组件清单。取值统一用 awk（ffmpeg 列表项行尾带空格，正则 $ 锚点匹配不上）；
#    每处都带 `|| true`，否则产物起不来时 set -e 会抢在 check_contains 之前掐断，
#    用户只看得到脚本莫名退出、看不到究竟缺了哪一项
PROTOCOLS="$(./ffmpeg.exe -hide_banner -protocols 2>&1 | awk '$1=="fd"||$1=="file"||$1=="pipe" {if (!seen[$1]++) printf "%s ", $1}' || true)"
DEMUXERS="$(./ffmpeg.exe -hide_banner -demuxers 2>&1 | awk '$2=="rawvideo" {printf "%s ", $2}' || true)"
ENCODERS="$(./ffmpeg.exe -hide_banner -encoders 2>&1 | awk '$2=="libx264" {printf "%s ", $2}' || true)"
MUXERS="$(./ffmpeg.exe -hide_banner -muxers 2>&1 | awk '$1=="E" && ($2=="mp4" || $2=="mov") {printf "%s ", $2}' || true)"
FILTERS="$(./ffmpeg.exe -hide_banner -filters 2>&1 | awk '$2=="crop"||$2=="scale"||$2=="format" {printf "%s ", $2}' || true)"
echo "  协议：$PROTOCOLS"
echo "  解复用：$DEMUXERS"
echo "  编码器：$ENCODERS"
echo "  封装：$MUXERS"
echo "  滤镜：$FILTERS"

check_contains() { # $1=项名 $2=实际值 $3=必需子串
  case "$2" in
    *"$3"*) ;;
    *) echo "  ❌ 自检失败：$1 缺少 $3（实际值：'$2'）" >&2; exit 1 ;;
  esac
}
for p in fd file pipe; do check_contains "协议" "$PROTOCOLS" "$p"; done
check_contains "解复用器" "$DEMUXERS" "rawvideo"
check_contains "编码器" "$ENCODERS" "libx264"
for m in mp4 mov; do check_contains "封装" "$MUXERS" "$m"; done
for f in crop scale format; do check_contains "滤镜" "$FILTERS" "$f"; done

# 3) 端到端冒烟：灌 3 帧合成数据，跑一次与 recording/video_encoder.rs 完全相同的命令行。
#    上面的清单只证明"组件被编译进来了"，这一步才证明"这条链路真能跑通"——
#    当年漏掉 fd 协议那类缺陷，只有真跑一次才发现得了
SMOKE_DIR="$BUILD_DIR/smoke"
mkdir -p "$SMOKE_DIR"
head -c $((64 * 48 * 4 * 3)) /dev/zero > "$SMOKE_DIR/frames.bgra"
if ./ffmpeg.exe -y -loglevel error -f rawvideo -pix_fmt bgra -s 64x48 -r 10 -i - \
     -c:v libx264 -preset ultrafast -crf 23 \
     -vf "crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0" \
     -pix_fmt yuv420p -movflags +faststart "$SMOKE_DIR/out.mp4" \
     < "$SMOKE_DIR/frames.bgra" 2>"$SMOKE_DIR/err.txt" \
   && [ -s "$SMOKE_DIR/out.mp4" ]; then
  echo "  端到端冒烟：编码 3 帧 → $(stat -c%s "$SMOKE_DIR/out.mp4") 字节 ✓"
else
  echo "  ❌ 端到端冒烟失败，产物无法完成一次真实编码：" >&2
  sed 's/^/      /' "$SMOKE_DIR/err.txt" >&2 2>/dev/null || true
  exit 1
fi

# ── 7. 可选安装到仓库 ────────────────────────────────────────────
if [ "$INSTALL" -eq 1 ]; then
  DEST="$REPO_ROOT/src-tauri/binaries/ffmpeg.exe"
  log "覆盖 $DEST"
  # binaries/ 在 .gitignore 中，全新 clone 时该目录并不存在
  mkdir -p "$(dirname "$DEST")"
  if [ -f "$DEST" ]; then
    # 备份放到构建目录而非 binaries/：后者每跑一次 --install 就多留一个约 4 MB 文件，
    # 且没有任何机制清理，会悄悄堆积
    BAK="$BUILD_DIR/ffmpeg.exe.bak.$(date +%Y%m%d%H%M%S)"
    cp "$DEST" "$BAK"
    echo "  原文件已备份到 $BAK"
  fi
  cp ffmpeg.exe "$DEST"
  ls -lh "$DEST"
fi

log "完成"
echo "  产物：$BUILD_DIR/ffmpeg-${FFMPEG_VERSION}/ffmpeg.exe"
echo "  下一步：按脚本头部说明用 PSNR 复核，并跑 cargo test video_encoder 确认录制链路。"
