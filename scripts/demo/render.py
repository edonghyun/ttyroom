#!/usr/bin/env python3
"""Compose the two actual browser recordings; never synthesize terminal output."""
import argparse
import json
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--font', required=True, type=pathlib.Path, help='Font file with Korean glyphs')
args = parser.parse_args()
if not args.font.is_file():
    parser.error('font file does not exist')
source = ROOT / 'artifacts/demo'
target = ROOT / 'docs/demo'
target.mkdir(parents=True, exist_ok=True)
manifest = json.loads((source / 'manifest.json').read_text())
if manifest.get('status') != 'complete':
    raise SystemExit('Recording has not completed successfully; refusing stale video files')


def probe(path):
    return float(subprocess.check_output([
        'ffprobe', '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', str(path),
    ], text=True))


def filter_path(path):
    return str(path).replace('\\', '\\\\').replace(':', '\\:').replace("'", "\\'")


# Each context records independently. Align starts and preserve the pauses within the successful take.
duration = min(probe(source / 'alice.webm'), probe(source / 'bob.webm'))
with tempfile.TemporaryDirectory(prefix='ttyroom-captions-') as temporary:
    captions = pathlib.Path(temporary)
    filters = [
        '[0:v]setpts=PTS-STARTPTS,fps=25[left]',
        '[1:v]setpts=PTS-STARTPTS,fps=25[right]',
        '[left][right]hstack=inputs=2:shortest=1,pad=2200:930:0:110:color=0x101826[panels]',
    ]
    overlays = []

    def text_overlay(name, text, x, y, size, start=None, end=None):
        path = captions / (name + '.txt')
        path.write_text(text)
        overlay = (f"drawtext=fontfile='{filter_path(args.font.resolve())}'"
                   f":textfile='{filter_path(path)}':fontcolor=white:fontsize={size}:x={x}:y={y}")
        if start is not None:
            overlay += f":enable='between(t,{start:.3f},{end:.3f})'"
        overlays.append(overlay)

    text_overlay('alice', 'ALICE  /  참여자 A', 28, 74, 23)
    text_overlay('bob', 'BOB  /  참여자 B', 1128, 74, 23)
    text_overlay('footer', '실제 브라우저 녹화 · 테스트로 연결 중단 · 두 화면을 나란히 편집 · 소리 없음', 28, 890, 22)
    for index, scene in enumerate(manifest['scenes']):
        end = manifest['scenes'][index + 1]['at'] if index + 1 < len(manifest['scenes']) else duration
        text_overlay(str(index), scene['title'], 28, 22, 30, scene['at'], end)
    filters.append('[panels]' + ','.join(overlays) + '[video]')
    subprocess.run([
        'ffmpeg', '-hide_banner', '-loglevel', 'warning', '-y',
        '-i', str(source / 'alice.webm'), '-i', str(source / 'bob.webm'),
        '-filter_complex', ';'.join(filters), '-map', '[video]', '-an',
        '-t', str(duration), '-c:v', 'libx264', '-crf', '24', '-preset', 'medium',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(target / 'ttyroom-demo.mp4'),
    ], check=True)
subprocess.run([
    'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-ss', '28',
    '-i', str(target / 'ttyroom-demo.mp4'), '-frames:v', '1', str(target / 'poster.png'),
], check=True)
print(json.dumps({'seconds': duration, 'bytes': (target / 'ttyroom-demo.mp4').stat().st_size}))
