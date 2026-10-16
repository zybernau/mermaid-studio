export function downloadTextFile(filename: string, text: string, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function downloadSvg(svg: string, filename = 'diagram.svg') {
  downloadTextFile(filename, svg, 'image/svg+xml');
}

function inlineFonts(svg: string): string {
  // Ensure a sane font stack is present so PNG export doesn't fall back oddly.
  if (svg.includes('font-family')) return svg;
  return svg.replace(/<svg([^>]*)>/, `<svg$1><style>text{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}</style>`);
}

export async function svgToPngBlob(svg: string, scale = 3): Promise<Blob> {
  const fixed = inlineFonts(svg);
  const svgBlob = new Blob([fixed], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  try {
    const img = new Image();
    const loaded = new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Could not rasterize SVG'));
    });
    img.src = url;
    await loaded;

    // Resolve intrinsic size from the svg tag; fall back to rendered size.
    const dims = parseSvgSize(fixed, img);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(dims.w * scale));
    canvas.height = Math.max(1, Math.round(dims.h * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D unavailable');
    ctx.fillStyle = '#ffffff';
    // Fill white unless caller wants transparency — white looks better for docs.
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, dims.w, dims.h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNG encoding failed');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function parseSvgSize(svg: string, img: HTMLImageElement): { w: number; h: number } {
  const wMatch = svg.match(/width="([\d.]+)/);
  const hMatch = svg.match(/height="([\d.]+)/);
  const vbMatch = svg.match(/viewBox="[\d.\-]+\s+[\d.\-]+\s+([\d.]+)\s+([\d.]+)/);
  let w = wMatch ? parseFloat(wMatch[1]) : NaN;
  let h = hMatch ? parseFloat(hMatch[1]) : NaN;
  if ((!w || !h) && vbMatch) {
    w = parseFloat(vbMatch[1]);
    h = parseFloat(vbMatch[2]);
  }
  if (!w || !h) {
    w = img.naturalWidth || 1200;
    h = img.naturalHeight || 800;
  }
  // Mermaid sometimes emits huge max-width diagrams; clamp to sane bound.
  w = Math.min(w, 4000);
  h = Math.min(h, 4000);
  return { w, h };
}

export async function downloadPng(svg: string, filename = 'diagram.png', scale = 3) {
  const blob = await svgToPngBlob(svg, scale);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export async function copySvgToClipboard(svg: string) {
  await navigator.clipboard.writeText(svg);
}

export async function copyPngToClipboard(svg: string) {
  const blob = await svgToPngBlob(svg, 3);
  // ClipboardItem support varies; Safari needs image/png only.
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}
