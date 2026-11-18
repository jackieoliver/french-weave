// Paraguayan Guaraní starter. See docs/guarani-starter.md for sources and senses.
// The version is a persistent history key. Keep it when adding vocabulary.
// Keep shipped target forms available to the backup reader.
export const GUARANI_PACK = {
  version: '0000000000000001',
  words: [
    ['y', 'water', 1],
    ['yvoty', 'flower', 1],
    ['kuarahy', 'sun', 1],
    ['jasy', 'moon', 1],
    ['ama', 'rain', 1],
    ['yvytu', 'wind', 1],
    ['panambi', 'butterfly', 1],
    ['yva', 'fruit', 1],
    ['yvyra', 'tree', 1],
    ['mainumby', 'hummingbird', 2],
    ['ysapy', 'dew', 2],
    ['ysyry', 'stream', 2],
    ['ytororõ', 'waterfall', 2],
    ['jasyrendy', 'moonlight', 2],
  ].map(([fr, en, level]) => ({ fr, en, level, hint: '' })),
};
