export async function extractColorsFromImage(imgSrc: string): Promise<[string, string, string]> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const size = 64;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("Canvas not available"));

      ctx.drawImage(img, 0, 0, size, size);
      const { data } = ctx.getImageData(0, 0, size, size);

      const pixels: [number, number, number][] = [];
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];

        if (a < 128) continue;
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum < 15 || lum > 240) continue;
        pixels.push([r, g, b]);
      }

      if (pixels.length < 3) return reject(new Error("Not enough color data in the avatar"));

      const buckets = medianCut(pixels, 3);
      const colors = buckets.map((bucket) => {
        const avg = bucket.reduce((acc, pixel) => [acc[0] + pixel[0], acc[1] + pixel[1], acc[2] + pixel[2]], [
          0, 0, 0,
        ] as [number, number, number]);

        return [
          Math.round(avg[0] / bucket.length),
          Math.round(avg[1] / bucket.length),
          Math.round(avg[2] / bucket.length),
        ] as [number, number, number];
      });

      const saturation = ([r, g, b]: [number, number, number]) => {
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        return max === 0 ? 0 : (max - min) / max;
      };
      colors.sort((left, right) => saturation(right) - saturation(left));

      const toHex = ([r, g, b]: [number, number, number]) =>
        `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;

      const nameColor = toHex(colors[0]);
      const dialogueColor = toHex(colors[1] ?? colors[0]);
      const boxRgb = colors[2] ?? colors[1] ?? colors[0];
      const boxColor = `rgba(${boxRgb[0]}, ${boxRgb[1]}, ${boxRgb[2]}, 0.25)`;

      resolve([nameColor, dialogueColor, boxColor]);
    };
    img.onerror = () => reject(new Error("Failed to load avatar image"));
    img.src = imgSrc;
  });
}

function medianCut(pixels: [number, number, number][], depth: number): [number, number, number][][] {
  if (depth <= 1 || pixels.length < 2) return [pixels];

  let maxRange = 0;
  let splitChannel = 0;
  for (let channel = 0; channel < 3; channel++) {
    const values = pixels.map((pixel) => pixel[channel]);
    const range = Math.max(...values) - Math.min(...values);
    if (range > maxRange) {
      maxRange = range;
      splitChannel = channel;
    }
  }

  pixels.sort((left, right) => left[splitChannel] - right[splitChannel]);
  const mid = Math.floor(pixels.length / 2);
  return [...medianCut(pixels.slice(0, mid), depth - 1), ...medianCut(pixels.slice(mid), depth - 1)];
}
