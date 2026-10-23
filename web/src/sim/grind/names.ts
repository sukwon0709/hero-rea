// Grinding simulator: story names of battles. The capture names a battle after its map in the
// HEXZMAP name table, which is the map's place, not the story's: the 원술 battle on the way to 회남
// is fought on map 13 ("하비"), the siege of 하비성 on map 14 ("신도1"), and both 서주 battles share
// map 8. Players (namu.wiki) know them by the story name; this table renames the battles whose map
// name differs from it, keyed by chapter/stage/block of the battle record. Code only, no game text.

const STORY: Record<string, string> = {
  '1/2/12': '회남', // 원술군 (기령) and 여포's wave, escape to the north-west fort
  '1/3/4': '하비', // 여포 토벌전: the siege of 하비성
  '1/4/15': '서주공방전', // one word: log parsers read the name up to the colon
};

/** The story name of a battle (chapter, stage, block of its record), else the map name. */
export function storyName(chapter: number, stage: number, block: number, mapName: string): string {
  return STORY[`${chapter}/${stage}/${block}`] ?? mapName;
}

/** Renames captured snapshots in place (captures made before the story names). */
export function applyStoryNames<T extends { chapter: number; stage: number; block: number; name: string }>(snaps: T[]): T[] {
  for (const s of snaps) s.name = storyName(s.chapter, s.stage, s.block, s.name);
  return snaps;
}
