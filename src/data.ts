import type { TextUnit, VersionDocument } from './types';

export const sampleTextA = `古之善为道者，微妙玄通，深不可识。夫唯不可识，故强为之容。
豫兮若冬涉川，犹兮若畏四邻。俨兮其若客，涣兮若冰之将释。
敦兮其若朴，旷兮其若谷，混兮其若浊。
孰能浊以静之徐清？孰能安以动之徐生？保此道者不欲盈。`;

export const sampleTextB = `古之善為道者，微玅玄通，深不可識。夫唯不可識，故強為之容。
與兮若冬涉川，猶兮若畏四鄰。儼兮其若客，渙兮若冰之將釋。
敦兮其若樸，曠兮其若谷，混兮其若濁。湛兮其若存。
孰能濁以靜之徐清？孰能安以動之徐生？保此道者不欲盈。`;

export const sampleTextC = `古代善于行道的人，精微通达，深邃得难以认识。正因为难以认识，只能勉强形容。
小心啊，像冬天涉水过河；警觉啊，像提防四周的邻国。恭敬啊，像做客；散融啊，像冰将要消解。
敦厚啊，像未经雕琢的原木；开阔啊，像山谷；浑厚啊，像浊水。
谁能使浊水安静下来，慢慢澄清？谁能在安定中发动，慢慢产生生机？持守此道的人，不求盈满。`;

export const sampleVersions: VersionDocument[] = [
  version('version-a', '王弼注本（底本）', '传世刻本', sampleTextA),
  version('version-b', '帛书参校本', '出土文献整理稿', sampleTextB),
  version('version-c', '现代语译本', '编辑部参考译文', sampleTextC)
];

function version(id: string, name: string, source: string, text: string): VersionDocument {
  return {
    id,
    name,
    source,
    text,
    units: splitIntoUnits(text, id),
    createdAt: '2026-09-25T02:00:00.000Z'
  };
}

export function splitIntoUnits(text: string, versionId: string): TextUnit[] {
  const paragraphs = text
    .split(/\n\s*\n|\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  const units: TextUnit[] = [];
  let sentenceOrder = 1;

  paragraphs.forEach((paragraph, paragraphIndex) => {
    const sentences = paragraph
      .split(/(?<=[。！？!?；;])/)
      .map((item) => item.trim())
      .filter(Boolean);
    const paragraphId = `${versionId}-p-${paragraphIndex + 1}`;
    (sentences.length ? sentences : [paragraph]).forEach((sentence) => {
      units.push({
        id: `${paragraphId}-s-${units.length + 1}`,
        paragraphId,
        paragraphOrder: paragraphIndex + 1,
        sentenceOrder: sentenceOrder++,
        paragraphText: paragraph,
        text: sentence
      });
    });
  });
  return units;
}
