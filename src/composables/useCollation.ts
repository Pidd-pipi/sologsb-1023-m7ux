import { computed, onMounted, ref, watch } from 'vue';
import { Message } from '@arco-design/web-vue';
import { sampleVersions, splitIntoUnits } from '../data';
import type {
  AlignmentRow,
  AlignmentTask,
  ComparisonRules,
  DifferenceStatus,
  PersistedCollationState,
  PersistedRow,
  PersistedTask,
  TextUnit,
  VersionDocument
} from '../types';

const STORAGE_KEY = 'sologsb-1023/multi-version-collation/v1';
const TASK_KEY = 'sologsb-1023/multi-version-collation/alignment-task/v1';
const BATCH_SIZE = 24;
const MAX_ERRORS = 3;

const variantMap: Record<string, string> = {
  為: '为',
  爲: '为',
  識: '识',
  強: '强',
  與: '与',
  猶: '犹',
  鄰: '邻',
  儼: '俨',
  渙: '涣',
  將: '将',
  樸: '朴',
  曠: '旷',
  濁: '浊',
  靜: '静',
  動: '动',
  玅: '妙',
  裏: '里',
  裡: '里',
  說: '说',
  國: '国'
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function yieldToBrowser() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isQuotaError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED';
  }
  return false;
}

/** FNV-1a 32 位哈希，用于生成正文指纹 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function normalized(value: string, rules: ComparisonRules) {
  let result = value.toLocaleLowerCase().trim();
  if (rules.ignoreVariants) {
    result = Array.from(result, (character) => variantMap[character] ?? character).join('');
  }
  if (rules.ignorePunctuation) {
    result = result.replace(/[\s，。！？；：、“”‘’「」『』（）()《》〈〉·,.!?;:'"[\]{}<>—\-…]/g, '');
  }
  return result;
}

function similarity(left: string, right: string) {
  const a = Array.from(left);
  const b = Array.from(right);
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const previous = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const old = previous[j];
      previous[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(previous[j], previous[j - 1]);
      diagonal = old;
    }
  }
  return previous[b.length] / Math.max(a.length, b.length);
}

function statusFor(left: TextUnit | undefined, right: TextUnit | undefined, ratio: number): DifferenceStatus {
  if (!left) return 'added';
  if (!right) return 'removed';
  if (ratio > 0.995) return 'same';
  if (ratio >= 0.38) return 'changed';
  return 'misaligned';
}

interface AlignState {
  rows: AlignmentRow[];
  leftIndex: number;
  rightIndex: number;
}

function createAlignState(): AlignState {
  return { rows: [], leftIndex: 0, rightIndex: 0 };
}

/** 处理一批句段，推进左右游标，结果追加到 state */
function alignBatch(
  state: AlignState,
  leftUnits: TextUnit[],
  rightUnits: TextUnit[],
  rules: ComparisonRules,
  maxUnits: number
): AlignState {
  let consumed = 0;
  while (consumed < maxUnits && (state.leftIndex < leftUnits.length || state.rightIndex < rightUnits.length)) {
    const left = leftUnits[state.leftIndex];
    const right = rightUnits[state.rightIndex];

    if (!left) {
      state.rows.push(makeRow(undefined, right, rules, '自动补齐右侧新增内容'));
      state.rightIndex += 1;
    } else if (!right) {
      state.rows.push(makeRow(left, undefined, rules, '自动标记左侧缺失内容'));
      state.leftIndex += 1;
    } else {
      const sameParagraph =
        left.paragraphOrder === right.paragraphOrder || Math.abs(left.paragraphOrder - right.paragraphOrder) <= 1;
      const ratio = similarity(normalized(left.text, rules), normalized(right.text, rules));
      const nextLeftRatio =
        leftUnits[state.leftIndex + 1] && right
          ? similarity(normalized(leftUnits[state.leftIndex + 1].text, rules), normalized(right.text, rules))
          : 0;
      const nextRightRatio =
        rightUnits[state.rightIndex + 1] && left
          ? similarity(normalized(left.text, rules), normalized(rightUnits[state.rightIndex + 1].text, rules))
          : 0;

      if (sameParagraph && (ratio >= 0.28 || (nextLeftRatio < 0.58 && nextRightRatio < 0.58))) {
        const score = Number(ratio.toFixed(3));
        state.rows.push({
          id: `row-${state.rows.length + 1}-${left.id}-${right.id}`,
          left,
          right,
          status: statusFor(left, right, score),
          similarity: score,
          note: '',
          source: '',
          accepted: score > 0.995,
          manuallyAdjusted: false
        });
        state.leftIndex += 1;
        state.rightIndex += 1;
      } else if (nextRightRatio > ratio && nextRightRatio > nextLeftRatio) {
        state.rows.push(makeRow(undefined, right, rules, '右侧有段落或句子插入'));
        state.rightIndex += 1;
      } else {
        state.rows.push(makeRow(left, undefined, rules, '左侧有段落或句子缺失'));
        state.leftIndex += 1;
      }
    }
    consumed += 1;
  }
  return state;
}

function makeRow(
  left: TextUnit | undefined,
  right: TextUnit | undefined,
  rules: ComparisonRules,
  source: string
): AlignmentRow {
  const score = left && right ? Number(similarity(normalized(left.text, rules), normalized(right.text, rules)).toFixed(3)) : 0;
  return {
    id: `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    left,
    right,
    status: statusFor(left, right, score),
    similarity: score,
    note: '',
    source,
    accepted: score > 0.995,
    manuallyAdjusted: false
  };
}

function defaultRules(): ComparisonRules {
  return { ignorePunctuation: true, ignoreVariants: true, candidateWindow: 3 };
}

/** 计算底本 + 参校本 + 规则的指纹 */
function computeFingerprint(left: VersionDocument, right: VersionDocument, rules: ComparisonRules): string {
  const parts = [left.id, right.id, JSON.stringify(rules)];
  for (const unit of left.units) parts.push(unit.id, unit.text);
  for (const unit of right.units) parts.push(unit.id, unit.text);
  return fnv1a(parts.join('|'));
}

function createTask(left: VersionDocument, right: VersionDocument, rules: ComparisonRules): AlignmentTask {
  const now = new Date().toISOString();
  return {
    id: '',
    manifest: {
      leftVersionId: left.id,
      rightVersionId: right.id,
      rules: { ...rules },
      fingerprint: computeFingerprint(left, right, rules)
    },
    status: 'running',
    totalUnits: left.units.length + right.units.length,
    processedUnits: 0,
    leftIndex: 0,
    rightIndex: 0,
    rows: [],
    errorCount: 0,
    batchSize: BATCH_SIZE,
    startedAt: now,
    updatedAt: now
  };
}

function pairKey(row: AlignmentRow): string {
  return `${row.left?.id ?? ''}|${row.right?.id ?? ''}`;
}

/** 按左右单元配对关系，把旧行的校记、来源、接受判断带给新对齐结果 */
function carryOverNotes(next: AlignmentRow[], previous: AlignmentRow[]): AlignmentRow[] {
  const previousByPair = new Map<string, AlignmentRow>();
  for (const row of previous) {
    const key = pairKey(row);
    if (key !== '|') previousByPair.set(key, row);
  }
  return next.map((row) => {
    const old = previousByPair.get(pairKey(row));
    if (!old) return row;
    return {
      ...row,
      note: old.note,
      source: old.source,
      accepted: old.accepted,
      manuallyAdjusted: old.manuallyAdjusted || row.manuallyAdjusted
    };
  });
}

function toPersistedRow(row: AlignmentRow): PersistedRow {
  return {
    id: row.id,
    leftId: row.left?.id ?? null,
    rightId: row.right?.id ?? null,
    status: row.status,
    similarity: row.similarity,
    note: row.note,
    source: row.source,
    accepted: row.accepted,
    manuallyAdjusted: row.manuallyAdjusted
  };
}

function compactRows(rows: AlignmentRow[]): PersistedRow[] {
  return rows.map(toPersistedRow);
}

function buildUnitMap(versions: VersionDocument[]): Map<string, TextUnit> {
  const map = new Map<string, TextUnit>();
  for (const version of versions) {
    for (const unit of version.units) map.set(unit.id, unit);
  }
  return map;
}

function rehydrateRows(persisted: PersistedRow[], unitMap: Map<string, TextUnit>): AlignmentRow[] {
  return persisted.map((p) => ({
    id: p.id,
    left: p.leftId ? unitMap.get(p.leftId) : undefined,
    right: p.rightId ? unitMap.get(p.rightId) : undefined,
    status: p.status,
    similarity: p.similarity,
    note: p.note,
    source: p.source,
    accepted: p.accepted,
    manuallyAdjusted: p.manuallyAdjusted
  }));
}

export function useCollation() {
  const versions = ref<VersionDocument[]>(clone(sampleVersions));
  const leftVersionId = ref(versions.value[0].id);
  const rightVersionId = ref(versions.value[1].id);
  const rows = ref<AlignmentRow[]>([]);
  const rules = ref<ComparisonRules>(defaultRules());
  const selectedRowId = ref('');
  const selectedRowIds = ref<(string | number)[]>([]);
  const processing = ref(false);
  const progress = ref(0);
  const message = ref('正在载入本地校勘数据…');
  const history = ref<string[]>([]);
  const future = ref<string[]>([]);
  const canUndo = computed(() => history.value.length > 0);
  const canRedo = computed(() => future.value.length > 0);
  const leftVersion = computed(() => versions.value.find((item) => item.id === leftVersionId.value));
  const rightVersion = computed(() => versions.value.find((item) => item.id === rightVersionId.value));
  const selectedRow = computed(() => rows.value.find((item) => item.id === selectedRowId.value));
  const differenceCount = computed(() => rows.value.filter((row) => row.status !== 'same').length);
  const acceptedCount = computed(() => rows.value.filter((row) => row.accepted).length);
  const unresolvedCount = computed(() => rows.value.filter((row) => !row.accepted && row.status !== 'same').length);

  /** 可恢复的未完成 / 失败任务 */
  const resumableTask = ref<AlignmentTask | null>(null);
  /** 本地容量不足、已降级保存的标记 */
  const storageDegraded = ref(false);

  let taskGeneration = 0;
  let activeTaskId = '';
  let restoring = true;

  function snapshot(): string {
    const data: PersistedCollationState = {
      versions: versions.value,
      leftVersionId: leftVersionId.value,
      rightVersionId: rightVersionId.value,
      rows: rows.value as unknown as PersistedRow[],
      rules: rules.value,
      selectedRowId: selectedRowId.value
    };
    return JSON.stringify(data);
  }

  function buildStatePayload(degraded: boolean): PersistedCollationState {
    return {
      versions: degraded ? versions.value.map((version) => ({ ...version, units: [] })) : versions.value,
      leftVersionId: leftVersionId.value,
      rightVersionId: rightVersionId.value,
      rows: compactRows(rows.value),
      rules: rules.value,
      selectedRowId: selectedRowId.value,
      storageDegraded: degraded
    };
  }

  function persist() {
    const degraded = storageDegraded.value;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(buildStatePayload(degraded)));
    } catch (error) {
      if (isQuotaError(error) && !degraded) {
        storageDegraded.value = true;
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(buildStatePayload(true)));
          Message.warning('浏览器本地容量不足，已降级为精简保存（正文与校记仍保留），建议导出 JSON 备份');
        } catch {
          Message.error('本地容量严重不足，无法保存进度，请立即导出 JSON 备份');
        }
      } else {
        Message.error('本地保存失败，请导出备份');
      }
    }
  }

  function persistTask(task: AlignmentTask) {
    if (task.id !== activeTaskId) return;
    const payload: PersistedTask = { ...task, rows: compactRows(task.rows) };
    try {
      localStorage.setItem(TASK_KEY, JSON.stringify(payload));
    } catch (error) {
      if (isQuotaError(error) && !storageDegraded.value) {
        storageDegraded.value = true;
        try {
          localStorage.setItem(TASK_KEY, JSON.stringify({ ...payload, rows: [] }));
          Message.warning('浏览器本地容量不足，任务进度已降级保存（仅保留断点），建议导出备份');
        } catch {
          Message.error('任务进度无法保存，请导出备份');
        }
      }
    }
  }

  function loadTask(): AlignmentTask | null {
    try {
      const raw = localStorage.getItem(TASK_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as PersistedTask;
      if (!parsed || !parsed.manifest) return null;
      for (const version of versions.value) {
        if (!version.units || !version.units.length) {
          version.units = splitIntoUnits(version.text, version.id);
        }
      }
      const unitMap = buildUnitMap(versions.value);
      return { ...parsed, rows: rehydrateRows(parsed.rows ?? [], unitMap) };
    } catch {
      return null;
    }
  }

  function clearTask() {
    try {
      localStorage.removeItem(TASK_KEY);
    } catch {
      /* ignore */
    }
  }

  function restore(raw: string) {
    const parsed = JSON.parse(raw) as PersistedCollationState & { rows?: Array<PersistedRow | AlignmentRow> };
    for (const version of parsed.versions) {
      if (!version.units || !version.units.length) {
        version.units = splitIntoUnits(version.text, version.id);
      }
    }
    versions.value = parsed.versions;
    leftVersionId.value = parsed.leftVersionId;
    rightVersionId.value = parsed.rightVersionId;
    rules.value = parsed.rules;
    selectedRowId.value = parsed.selectedRowId;
    storageDegraded.value = !!parsed.storageDegraded;

    const first = parsed.rows?.[0];
    if (first && typeof first === 'object' && 'leftId' in first) {
      const unitMap = buildUnitMap(versions.value);
      rows.value = rehydrateRows(parsed.rows as PersistedRow[], unitMap);
    } else {
      rows.value = (parsed.rows as AlignmentRow[]) ?? [];
    }
    persist();
  }

  function commit(label: string, mutate: () => void) {
    history.value.push(snapshot());
    if (history.value.length > 50) history.value.shift();
    future.value = [];
    mutate();
    message.value = label;
    persist();
  }

  function undo() {
    const previous = history.value.pop();
    if (!previous) return;
    future.value.push(snapshot());
    restore(previous);
    message.value = '已撤销上一步操作';
  }

  function redo() {
    const next = future.value.pop();
    if (!next) return;
    history.value.push(snapshot());
    restore(next);
    message.value = '已重做上一步操作';
  }

  function isFingerprintCurrent(fingerprint: string): boolean {
    if (!leftVersion.value || !rightVersion.value) return false;
    return computeFingerprint(leftVersion.value, rightVersion.value, rules.value) === fingerprint;
  }

  function invalidateTask() {
    taskGeneration += 1;
  }

  async function runAlignment(commitHistory = true, resumeTask: AlignmentTask | null = null) {
    if (!leftVersion.value || !rightVersion.value) return;
    taskGeneration += 1;
    const generation = taskGeneration;

    const isResume = !!resumeTask && resumeTask.status !== 'done';
    const task: AlignmentTask = isResume
      ? { ...resumeTask!, id: `task-${generation}`, status: 'running', lastError: undefined }
      : createTask(leftVersion.value, rightVersion.value, rules.value);
    if (!isResume) task.id = `task-${generation}`;
    activeTaskId = task.id;

    // 降级保存时任务行可能被清空，此时无法从断点续行，改为从头开始
    const degradedResume = isResume && task.rows.length === 0 && task.leftIndex + task.rightIndex > 0;
    const state: AlignState =
      isResume && !degradedResume
        ? { rows: task.rows, leftIndex: task.leftIndex, rightIndex: task.rightIndex }
        : createAlignState();
    if (degradedResume) {
      task.leftIndex = 0;
      task.rightIndex = 0;
      task.processedUnits = 0;
    }

    processing.value = true;
    resumableTask.value = null;
    message.value = isResume ? '正在从断点继续对齐…' : '正在分片执行自动对齐…';
    progress.value = task.totalUnits ? Math.round((task.processedUnits / task.totalUnits) * 100) : 0;

    const previous = commitHistory ? snapshot() : '';

    try {
      while (state.leftIndex < leftVersion.value.units.length || state.rightIndex < rightVersion.value.units.length) {
        if (generation !== taskGeneration || !isFingerprintCurrent(task.manifest.fingerprint)) {
          task.status = 'invalid';
          task.updatedAt = new Date().toISOString();
          persistTask(task);
          message.value = '输入已变更，对齐任务已作废；已有校记与接受判断保留';
          return;
        }
        try {
          alignBatch(state, leftVersion.value.units, rightVersion.value.units, rules.value, BATCH_SIZE);
        } catch (error) {
          task.errorCount += 1;
          task.lastError = errorMessage(error);
          task.updatedAt = new Date().toISOString();
          persistTask(task);
          if (task.errorCount >= MAX_ERRORS) {
            task.status = 'failed';
            message.value = `对齐已停止：连续 ${task.errorCount} 次分片执行失败（${task.lastError}）。可修正输入后重试。`;
            return;
          }
          message.value = `分片执行异常（第 ${task.errorCount} 次），正在重试同一批次…`;
          await yieldToBrowser();
          continue;
        }

        task.rows = state.rows;
        task.leftIndex = state.leftIndex;
        task.rightIndex = state.rightIndex;
        task.processedUnits = state.leftIndex + state.rightIndex;
        task.updatedAt = new Date().toISOString();
        persistTask(task);
        progress.value = Math.round((task.processedUnits / Math.max(1, task.totalUnits)) * 100);
        await yieldToBrowser();
      }

      if (generation !== taskGeneration || !isFingerprintCurrent(task.manifest.fingerprint)) {
        task.status = 'invalid';
        task.updatedAt = new Date().toISOString();
        persistTask(task);
        message.value = '输入已变更，迟到的对齐结果未写入；已有校记保留';
        return;
      }

      task.status = 'done';
      task.processedUnits = task.totalUnits;
      task.updatedAt = new Date().toISOString();
      if (commitHistory) {
        history.value.push(previous);
        future.value = [];
      }
      rows.value = carryOverNotes(state.rows, rows.value);
      selectedRowId.value = rows.value.find((row) => row.status !== 'same')?.id ?? rows.value[0]?.id ?? '';
      selectedRowIds.value = [];
      persistTask(task);
      persist();
      message.value = `自动对齐完成：${rows.value.filter((row) => row.status !== 'same').length} 处差异`;
    } finally {
      if (generation === taskGeneration) {
        processing.value = false;
      }
    }
  }

  function resumeTask() {
    const task = resumableTask.value;
    if (!task) return;
    if (task.status === 'failed') {
      task.errorCount = 0;
      task.lastError = undefined;
    }
    void runAlignment(false, task);
  }

  function discardTask() {
    clearTask();
    resumableTask.value = null;
    progress.value = 0;
    message.value = '已放弃未完成的对齐任务';
  }

  function recalculate() {
    commit('已按比较规则重算差异', () => {
      rows.value = rows.value.map((row) => {
        if (!row.left || !row.right) return row;
        const score = Number(
          similarity(normalized(row.left.text, rules.value), normalized(row.right.text, rules.value)).toFixed(3)
        );
        return { ...row, similarity: score, status: statusFor(row.left, row.right, score) };
      });
      selectedRowIds.value = [];
    });
  }

  function updateRow(id: string, patch: Partial<AlignmentRow>) {
    commit('已更新校勘行', () => {
      const row = rows.value.find((item) => item.id === id);
      if (row) Object.assign(row, patch, { manuallyAdjusted: true });
    });
  }

  function shiftPairing(id: string, direction: -1 | 1) {
    commit(direction < 0 ? '已向前调整错位' : '已向后调整错位', () => {
      const index = rows.value.findIndex((row) => row.id === id);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= rows.value.length) return;
      const current = rows.value[index];
      const target = rows.value[targetIndex];
      const currentLeft = current.left;
      current.left = target.left;
      target.left = currentLeft;
      for (const row of [current, target]) {
        if (row.left && row.right) {
          row.similarity = Number(
            similarity(normalized(row.left.text, rules.value), normalized(row.right.text, rules.value)).toFixed(3)
          );
          row.status = statusFor(row.left, row.right, row.similarity);
        } else {
          row.status = row.left ? 'removed' : 'added';
          row.similarity = 0;
        }
        row.manuallyAdjusted = true;
      }
    });
  }

  function moveRow(id: string, direction: -1 | 1) {
    commit('已移动校勘顺序', () => {
      const index = rows.value.findIndex((row) => row.id === id);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= rows.value.length) return;
      const [row] = rows.value.splice(index, 1);
      rows.value.splice(targetIndex, 0, row);
      row.manuallyAdjusted = true;
    });
  }

  function acceptRows(ids: string[]) {
    if (!ids.length) return;
    commit(`已接受 ${ids.length} 条校对建议`, () => {
      const selected = new Set(ids);
      rows.value.forEach((row) => {
        if (selected.has(row.id)) row.accepted = true;
      });
      selectedRowIds.value = [];
    });
  }

  function acceptAll() {
    commit('已批量接受全部差异建议', () => {
      rows.value.forEach((row) => {
        row.accepted = true;
      });
      selectedRowIds.value = [];
    });
  }

  function nextDifference() {
    const start = rows.value.findIndex((row) => row.id === selectedRowId.value);
    for (let offset = 1; offset <= rows.value.length; offset += 1) {
      const index = (start + offset) % rows.value.length;
      const row = rows.value[index];
      if (row && row.status !== 'same' && !row.accepted) {
        selectedRowId.value = row.id;
        message.value = `已跳到第 ${index + 1} 条未接受差异`;
        persist();
        return;
      }
    }
    message.value = '没有更多未接受的差异';
  }

  function addVersion(name: string, source: string, text: string) {
    const id = `version-${Date.now().toString(36)}`;
    const item: VersionDocument = {
      id,
      name: name.trim() || `版本 ${versions.value.length + 1}`,
      source: source.trim() || '手工导入',
      text,
      units: splitIntoUnits(text, id),
      createdAt: new Date().toISOString()
    };
    commit(`已导入版本：${item.name}`, () => {
      versions.value.push(item);
    });
    rightVersionId.value = id;
  }

  function exportMarkdown() {
    const changed = rows.value.filter((row) => row.status !== 'same' || row.note || row.source);
    const lines = [
      '# 校勘记',
      '',
      `- 底本：${leftVersion.value?.name ?? '未选择'}`,
      `- 参校本：${rightVersion.value?.name ?? '未选择'}`,
      `- 比较规则：${rules.value.ignorePunctuation ? '忽略标点；' : ''}${rules.value.ignoreVariants ? '忽略异体字；' : ''}保留正文。`,
      `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
      '',
      '| 序 | 类别 | 底本 | 参校本 | 校记 | 来源 | 状态 |',
      '|---|---|---|---|---|---|---|'
    ];
    changed.forEach((row, index) => {
      const cell = (value?: string) => (value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
      lines.push(
        `| ${index + 1} | ${statusLabel(row.status)} | ${cell(row.left?.text)} | ${cell(row.right?.text)} | ${cell(row.note)} | ${cell(row.source)} | ${row.accepted ? '已接受' : '待处理'} |`
      );
    });
    lines.push('', `共 ${changed.length} 条校勘记录。`);
    return lines.join('\n');
  }

  function exportJson() {
    return JSON.stringify(
      {
        left: leftVersion.value,
        right: rightVersion.value,
        rules: rules.value,
        rows: rows.value,
        exportedAt: new Date().toISOString()
      },
      null,
      2
    );
  }

  onMounted(() => {
    restoring = true;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        restore(raw);
        message.value = '已恢复浏览器中的校勘草稿';
      } else {
        message.value = '已载入示例版本，正在自动对齐…';
      }

      const task = loadTask();
      if (task && task.status === 'running') {
        if (task.manifest.fingerprint === computeFingerprint(leftVersion.value!, rightVersion.value!, rules.value)) {
          resumableTask.value = task;
          progress.value = task.totalUnits ? Math.round((task.processedUnits / task.totalUnits) * 100) : 0;
          message.value = `检测到未完成的对齐任务（已完成 ${progress.value}%），可从断点继续`;
        } else {
          clearTask();
        }
      } else if (task && task.status === 'failed') {
        resumableTask.value = task;
        progress.value = task.totalUnits ? Math.round((task.processedUnits / task.totalUnits) * 100) : 0;
        message.value = `对齐任务已停止：${task.lastError ?? '未知原因'}，可重试`;
      } else {
        if (!raw || rows.value.length === 0) {
          void runAlignment(false);
        } else {
          clearTask();
        }
      }
    } catch {
      message.value = '本地草稿读取失败，已载入示例数据';
      void runAlignment(false);
    } finally {
      restoring = false;
    }
  });

  watch([leftVersionId, rightVersionId], () => {
    if (restoring) return;
    invalidateTask();
    persist();
    void runAlignment(false);
  });

  watch([() => rules.value.ignorePunctuation, () => rules.value.ignoreVariants], () => {
    if (restoring) return;
    invalidateTask();
    recalculate();
  });

  return {
    versions,
    leftVersionId,
    rightVersionId,
    rows,
    rules,
    selectedRowId,
    selectedRowIds,
    processing,
    progress,
    message,
    history,
    future,
    canUndo,
    canRedo,
    leftVersion,
    rightVersion,
    selectedRow,
    differenceCount,
    acceptedCount,
    unresolvedCount,
    resumableTask,
    storageDegraded,
    runAlignment,
    resumeTask,
    discardTask,
    recalculate,
    updateRow,
    shiftPairing,
    moveRow,
    acceptRows,
    acceptAll,
    nextDifference,
    addVersion,
    undo,
    redo,
    exportMarkdown,
    exportJson,
    commit
  };
}

export function statusLabel(status: DifferenceStatus) {
  return {
    same: '相同',
    changed: '改动',
    added: '右侧新增',
    removed: '左侧删减',
    misaligned: '疑错位'
  }[status];
}
