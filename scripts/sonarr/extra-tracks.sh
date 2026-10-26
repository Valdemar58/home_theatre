#!/bin/sh
# Sonarr Custom Script (On Import / On Upgrade).
#
# Многие раздачи аниме кладут озвучки и субтитры отдельными файлами в подпапки:
#   Show/
#     Show - 01.mkv
#     RUS Sound/AniLibria/Show - 01.mka
#     RUS Sound/Dream Cast/Show - 01.mka
#     RUS Subs/Show - 01.ass
# Sonarr импортирует только видео. Этот скрипт находит такие файлы по имени эпизода
# и кладёт их рядом с импортированным видео (hardlink, иначе копия):
#   Show - S01E01 ....ru.AniLibria.mka
#   Show - S01E01 ....ru.Dream Cast.mka
#   Show - S01E01 ....ru.ass
# Jellyfin показывает их как отдельные аудиодорожки/субтитры с названием студии.
set -u

case "${sonarr_eventtype:-}" in
  Test) exit 0 ;;
  Download) ;;
  *) exit 0 ;;
esac

src="${sonarr_episodefile_sourcepath:-}"
dst="${sonarr_episodefile_path:-}"
[ -n "$src" ] && [ -n "$dst" ] || exit 0

src_dir=$(dirname "$src")
src_name=$(basename "$src"); src_base="${src_name%.*}"
dst_dir=$(dirname "$dst")
dst_name=$(basename "$dst"); dst_base="${dst_name%.*}"

# Корень раздачи: /data/torrents/<категория>/<папка раздачи>
case "$src" in
  /data/torrents/*/*/*)
    rel="${src#/data/torrents/}"
    category="${rel%%/*}"
    rest="${rel#*/}"
    root="/data/torrents/$category/${rest%%/*}"
    ;;
  *) root="$src_dir" ;;
esac

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

detect_lang() {
  p=$(lower "$1")
  case "$p" in
    *rus*|*russian*|*рус*|*Рус*|*РУС*) echo ru ;;
    *eng*|*english*) echo en ;;
    *jap*|*jpn*|*japanese*) echo ja ;;
    *) echo "$2" ;;
  esac
}

# Папки вида "RUS Sound", "Subs", "Audio" не являются названием студии
is_generic() {
  [ -z "$1" ] && return 0
  p=$(lower "$1")
  case "$p" in
    *sound*|*audio*|*sub*|*voice*|*dub*|*озвуч*|*звук*|*суб*|rus|eng|jap|jpn|ru|en|ja) return 0 ;;
  esac
  [ "$1" = "$(basename "$root")" ]
}

clean() {
  printf '%s' "$1" | tr '.[]()_' '      ' | sed 's/  */ /g; s/^ //; s/ $//'
}

find "$root" -type f \( -iname '*.mka' -o -iname '*.ac3' -o -iname '*.eac3' -o -iname '*.dts' \
  -o -iname '*.aac' -o -iname '*.flac' -o -iname '*.ass' -o -iname '*.ssa' -o -iname '*.srt' \) 2>/dev/null |
while IFS= read -r f; do
  fname=$(basename "$f")
  # Точка после имени, чтобы "Show - 1" не цеплял "Show - 10.mka"
  case "$fname" in
    "$src_base".*) ;;
    *) continue ;;
  esac
  fdir=$(dirname "$f")
  ext=$(lower "${fname##*.}")
  case "$ext" in
    ass|ssa|srt)
      # Субтитры из той же папки, что и видео, Sonarr импортирует сам
      [ "$fdir" = "$src_dir" ] && continue
      ;;
  esac

  lang=$(detect_lang "${f#"$root"/}" ru)

  studio=""
  parent=$(basename "$fdir")
  if [ "$fdir" != "$src_dir" ] && ! is_generic "$parent"; then
    studio=$(clean "$parent")
  fi
  if [ -z "$studio" ]; then
    # "Show - 01.AniLibria.mka" → AniLibria
    leftover="${fname#"$src_base"}"; leftover="${leftover%.*}"
    leftover=$(clean "$leftover")
    is_generic "$leftover" || studio="$leftover"
  fi

  name="$dst_base.$lang"
  [ -n "$studio" ] && name="$name.$studio"
  target="$dst_dir/$name.$ext"
  n=2
  while [ -e "$target" ]; do
    target="$dst_dir/$name.$n.$ext"; n=$((n + 1))
  done

  if ln "$f" "$target" 2>/dev/null || cp "$f" "$target"; then
    echo "extra-tracks: $f -> $target"
  else
    echo "extra-tracks: не удалось скопировать $f" >&2
  fi
done

exit 0
