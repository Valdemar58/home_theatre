export function activeTitleSection(sections: { id: string; top: number }[], anchor: number, atBottom: boolean) {
  if (atBottom) return sections.at(-1)?.id;
  return sections.filter(s => s.top <= anchor).at(-1)?.id ?? sections[0]?.id;
}
