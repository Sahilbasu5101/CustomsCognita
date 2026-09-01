import json, os, subprocess, sys, shutil, io
from pathlib import Path
from PIL import Image

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

PROJECT   = Path(__file__).parent.parent
CLIPS_DIR = PROJECT / "assets" / "clips"
FRAMES_DIR= PROJECT / "frames"
MASTER    = PROJECT / "assets" / "master.mp4"
FPS, WIDTH, XFADE = 12, 1400, 0.4

def find_ffmpeg():
    if shutil.which("ffmpeg"):
        return shutil.which("ffmpeg"), shutil.which("ffprobe")
    localapp = Path(os.environ.get("LOCALAPPDATA",""))
    for root, dirs, files in os.walk(localapp/"Microsoft"/"WinGet"/"Packages"):
        for f in files:
            if f.lower() == "ffmpeg.exe":
                ff = Path(root)/f
                fp = ff.parent/"ffprobe.exe"
                return str(ff), str(fp) if fp.exists() else str(ff)
    for c in [r"C:\ffmpeg\bin\ffmpeg.exe",r"C:\Program Files\ffmpeg\bin\ffmpeg.exe"]:
        if Path(c).exists():
            fp = Path(c).parent/"ffprobe.exe"
            return c, str(fp) if fp.exists() else c
    return None, None

FFMPEG, FFPROBE = find_ffmpeg()
if not FFMPEG:
    sys.exit("ffmpeg not found - run: winget install Gyan.FFmpeg then reopen terminal")
print("[OK] ffmpeg:", FFMPEG)

def run(cmd):
    cmd[0] = FFMPEG if cmd[0]=="ffmpeg" else (FFPROBE if cmd[0]=="ffprobe" else cmd[0])
    print("  $", " ".join(str(c) for c in cmd[:7]), "...")
    subprocess.run([str(c) for c in cmd], check=True)

def dur(p):
    r = subprocess.run([FFPROBE,"-v","error","-show_entries","format=duration",
        "-of","csv=p=0",str(p)],capture_output=True,text=True,check=True)
    return float(r.stdout.strip())

# collect clips
inputs=[]
for fn in ["ch1.mp4","ch2.mp4","ch3.mp4","ch4.mp4","ch5.mp4","ch6.mp4"]:
    p=CLIPS_DIR/fn
    if p.exists(): inputs.append((fn[:-4],p,dur(p)))
    else: print("  skip:",fn)

# synthesise ch6 by reversing ch5 if missing
if len(inputs)==5 and not (CLIPS_DIR/"ch6.mp4").exists():
    n,src,d = inputs[-1]
    rev = src.parent/(src.stem+"-rev.mp4")
    if not rev.exists():
        print("Reversing ch5 -> ch6-pullback...")
        run(["ffmpeg","-y","-v","-error","-i",str(src),"-vf","reverse","-an","-crf","18",str(rev)])
    inputs.append(("ch6-pullback",rev,dur(rev)))
    print("[OK] ch6 ready")

if not inputs: sys.exit("No clips found")
print(f"\n{len(inputs)} chapters:", [n for n,_,_ in inputs])

# probe size
pr = subprocess.run([FFPROBE,"-v","error","-select_streams","v",
    "-show_entries","stream=width,height","-of","csv=p=0",str(inputs[0][1])],
    capture_output=True,text=True,check=True)
W,H = pr.stdout.strip().split(",")
print(f"  size: {W}x{H}")

# build xfade concat
args=["ffmpeg","-y","-v","error"]
for _,src,_ in inputs: args+=["-i",str(src)]
flt=[]
for i in range(len(inputs)):
    flt.append(f"[{i}:v]scale={W}:{H}:force_original_aspect_ratio=decrease,"
               f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,fps=24,setsar=1[n{i}]")
meta=[{"name":inputs[0][0],"start":0.0}]
prev,prev_end="[n0]",inputs[0][2]
for i in range(1,len(inputs)):
    nm,_,d=inputs[i]
    off=prev_end-XFADE
    ot=f"[v{i}]"
    flt.append(f"{prev}[n{i}]xfade=transition=fade:duration={XFADE}:offset={off:.4f}{ot}")
    meta.append({"name":nm,"start":off})
    prev,prev_end=ot,off+d
total=prev_end

MASTER.parent.mkdir(parents=True,exist_ok=True)
args+=["-filter_complex",";".join(flt),"-map",prev,
       "-c:v","libx264","-crf","16","-pix_fmt","yuv420p",str(MASTER)]
print(f"\nBuilding master ({total:.1f}s)...")
run(args)

# slice frames
FRAMES_DIR.mkdir(parents=True,exist_ok=True)
for f in FRAMES_DIR.iterdir():
    if f.suffix in (".webp",".png"): f.unlink()
print(f"\nSlicing at {FPS}fps / {WIDTH}px...")
run(["ffmpeg","-y","-v","error","-i",str(MASTER),"-vf",f"fps={FPS},scale={WIDTH}:-2",
     str(FRAMES_DIR/"frame_%04d.png")])

# convert to webp
pngs=sorted(FRAMES_DIR.glob("*.png"))
print(f"Converting {len(pngs)} frames to WebP...")
for p in pngs:
    Image.open(p).save(p.with_suffix(".webp"),"WEBP",quality=82)
    p.unlink()

count=len(list(FRAMES_DIR.glob("*.webp")))
(FRAMES_DIR/"frames.json").write_text(json.dumps({"count":count,"pattern":"frames/frame_%04d.webp"}))
mb=sum(f.stat().st_size for f in FRAMES_DIR.glob("*.webp"))/1e6
print(f"\n[DONE] {count} frames, {mb:.1f} MB")
print("\nScroll fractions:")
for m in meta: print(f"  {m['name']:<16} {m['start']/total:.3f}")
print("\nReload http://localhost:8742")
