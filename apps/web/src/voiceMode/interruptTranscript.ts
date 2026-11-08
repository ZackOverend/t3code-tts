function words(text: string): string {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/['’]/gu, "")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).join(" ");
}

export function isInterruptTranscript(transcript: string, playbackText: string | null): boolean {
  const spoken = words(transcript);
  if (!spoken) return false;
  // AEC is the primary echo filter; reject normalized excerpts too, before interpreting commands.
  return playbackText === null || !` ${words(playbackText)} `.includes(` ${spoken} `);
}
