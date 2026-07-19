function countEncodingArtifacts(text) {
  if (typeof text !== "string" || !text) return 0;
  return (text.match(/\uFFFD/g) || []).length + (text.match(/Ã./g) || []).length;
}

export function repairRmmTextEncoding(value) {
  if (value == null || value === "") return value;
  if (typeof value !== "string") return value;

  let best = value;
  let bestScore = countEncodingArtifacts(value);

  const tryDecode = (encoding) => {
    try {
      const bytes = Uint8Array.from(value, (char) => char.charCodeAt(0) & 0xff);
      const decoded = new TextDecoder(encoding, { fatal: false }).decode(bytes);
      if (!decoded || decoded === value) return;
      const score = countEncodingArtifacts(decoded);
      if (score < bestScore) {
        best = decoded;
        bestScore = score;
      }
    } catch {
 /* ignore */
    }
  };

  if (bestScore > 0 || /[\u0080-\u00ff]/.test(value)) {
    tryDecode("utf-8");
    tryDecode("windows-1252");
  }

  return best;
}

export function repairRmmInventoryTextFields(value) {
  if (value == null) return value;
  if (typeof value === "string") return repairRmmTextEncoding(value);
  if (Array.isArray(value)) return value.map(repairRmmInventoryTextFields);
  if (typeof value === "object") {
    const next = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = repairRmmInventoryTextFields(entry);
    }
    return next;
  }
  return value;
}
