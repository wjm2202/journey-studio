// splice — build the finished guide video from a guide bundle.
// COMPOSES, doesn't reinvent: journey-studio makes the guide-specific BODY
// (slow to human pace + burned-in bottom step band + optional voice), then
// hands off to your proven add_intro.sh (the YouTube project) for the intro.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONT = path.resolve(HERE, '..', 'assets', 'font.ttf');
// ffmpeg filter paths: escape the chars its parser treats specially
const fesc = (p) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");

function probeWH(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file]).toString().trim();
  const [w, h] = out.split('x').map(Number);
  return { w, h };
}

function bandChain(steps, { H, B, rate, fontsize, dir }) {
  if (!steps.length) return 'null';
  const x = Math.round(B * 0.25);
  const y = H + Math.round(B * 0.26);
  return steps.map((s) => {
    const tf = path.join(dir, `band_${s.id}.txt`);
    writeFileSync(tf, `STEP ${s.index}/${steps.length}   ${s.title}` + (s.hint ? `\n${s.hint}` : ''));
    const S = ((s.startMs / 1000) * rate).toFixed(3);
    const E = ((s.endMs / 1000) * rate).toFixed(3);
    return `drawtext=fontfile='${fesc(FONT)}':textfile='${fesc(tf)}':fontcolor=white:fontsize=${fontsize}:x=${x}:y=${y}:line_spacing=6:enable='between(t,${S},${E})'`;
  }).join(',');
}

export function splice(slug, opts = {}) {
  const dir = path.resolve(opts.dir ?? 'guides', slug);
  const guide = JSON.parse(readFileSync(path.join(dir, 'guide.json'), 'utf8'));
  const raw = path.join(dir, 'raw.webm');
  if (!existsSync(raw)) throw new Error(`no raw.webm in ${dir} — run \`journey-studio build\` first`);

  const rate = Number(opts.rate ?? 1.75);
  const { w: W, h: H } = probeWH(raw);
  const B = Number(opts.band ?? Math.round(H * 0.16));
  const Hb = H + B;
  const FPS = Number(opts.fps ?? 30);
  const CRF = String(opts.crf ?? 16);
  const bandColor = opts.bandColor ?? '0x0b0b0f';
  const fontsize = Number(opts.fontsize ?? Math.round(B * 0.30));

  const voice = path.join(dir, 'voice.webm');
  const hasVoice = existsSync(voice);
  const chain = bandChain(guide.steps, { H, B, rate, fontsize, dir });
  const vf = `[0:v]setpts=${rate}*PTS,fps=${FPS},scale=${W}:${H},pad=${W}:${Hb}:0:0:color=${bandColor}[bg];[bg]${chain}[v]`;

  const body = path.join(dir, `${slug}.body.mp4`);
  const args = ['-y', '-i', raw];
  if (hasVoice) args.push('-i', voice);
  args.push('-filter_complex', hasVoice ? `${vf};[1:a]apad[a]` : vf, '-map', '[v]');
  if (hasVoice) args.push('-map', '[a]', '-shortest');
  args.push('-c:v', 'libx264', '-crf', CRF, '-preset', opts.preset ?? 'slow', '-pix_fmt', 'yuv420p');
  if (hasVoice) args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
  args.push(body);

  console.log(`  body ${W}x${Hb} @${rate}x · ${guide.steps.length} band step(s)${hasVoice ? ' + voice' : ' (no voice.webm yet — band-only preview)'}`);
  execFileSync('ffmpeg', ['-v', 'error', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });

  // intro: hand off to add_intro.sh (reused). MERGED=dir keeps output next to the bundle.
  const addIntro = opts.addIntro ?? process.env.ADD_INTRO;
  const final = path.join(dir, `${slug}.final.mp4`);
  if (addIntro && existsSync(addIntro)) {
    const env = { ...process.env, MERGED: dir, CRF };
    if (opts.intro ?? process.env.INTRO) env.INTRO = opts.intro ?? process.env.INTRO;
    execFileSync('bash', [addIntro, body], { env, stdio: ['ignore', 'inherit', 'inherit'] });
    const produced = path.join(dir, `${slug}.body - with intro.mp4`); // add_intro's SUFFIX default
    if (existsSync(produced)) renameSync(produced, final);
    console.log(`  ✓ intro prepended via ${path.basename(addIntro)}`);
  } else {
    renameSync(body, final);
    console.log(`  (no add_intro.sh — band-only. Pass --add-intro <path> or set ADD_INTRO to prepend the intro.)`);
  }
  const dur = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', final]).toString().trim();
  const hh = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'default=nw=1:nk=1', final]).toString().trim();
  console.log(`\n✓ ${path.relative(process.cwd(), final)}  (${dur}s, ${hh}px tall)`);
  return final;
}
