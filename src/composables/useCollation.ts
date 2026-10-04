import { computed, onMounted, ref, watch } from 'vue';
import { sampleVersions, splitIntoUnits } from '../data';
import type {
  AlignmentCheckpoint,
  AlignmentFingerprint,
  AlignmentRow,
  ComparisonRules,
  DifferenceStatus,
  PersistedCollationState,
  StorageDegradedLevel,
  TextUnit,
  VersionDocument
} from '../types';

const STORAGE_KEY = 'sologsb-1023/multi-version-collation/v1';
/** 固定分批量：每批最多消费 24 个句段（配对成功计 2 个，单侧插入计 1 个） */
const ALIGN_BATCH_SIZE = 24;
/** 同一批连续异常达到 3 次即停止 */
const MAX_BATCH_FAILURES = 3;
/** 运行中每 8 批落一次断点，避免每批写入造成 O(n²) 开销；关页面时再同步补写一次 */
const CHECKPOINT_SAVE_EVERY = 8;

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
  // 校勘状态全部是可序列化数据，JSON 深拷贝同时兼容 Vue 响应式 Proxy
  return JSON.parse(JSON.stringify(value)) as T;
}

function yieldToBrowser() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
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

/** 对齐游标的可持久化部分：行结果 + 两侧下标，足以从未完成片继续 */
interface AlignmentCursor {
  rows: AlignmentRow[];
  leftIndex: number;
  rightIndex: number;
}

function isAlignmentDone(state: { leftIndex: number; rightIndex: number }, leftUnits: TextUnit[], rightUnits: TextUnit[]) {
  return state.leftIndex >= leftUnits.length && state.rightIndex >= rightUnits.length;
}

function rowId(state: AlignmentCursor, left: TextUnit | undefined, right: TextUnit | undefined) {
  // 确定性编号：同一路径重复对齐会得到相同 id，便于断点续跑和校记沿用
  return `row-${String(state.rows.length + 1).padStart(4, '0')}-${left?.id ?? 'gap'}-${right?.id ?? 'gap'}`;
}

function makeRow(
  state: AlignmentCursor,
  left: TextUnit | undefined,
  right: TextUnit | undefined,
  rules: ComparisonRules,
  source: string
): AlignmentRow {
  const score = left && right ? Number(similarity(normalized(left.text, rules), normalized(right.text, rules)).toFixed(3)) : 0;
  return {
    id: rowId(state, left, right),
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

/** 推进一个句段步，返回本步消费的句段数（配对 2 / 单侧插入 1） */
function alignOneStep(state: AlignmentCursor, leftUnits: TextUnit[], rightUnits: TextUnit[], rules: ComparisonRules): number {
  const left = leftUnits[state.leftIndex];
  const right = rightUnits[state.rightIndex];

  if (!left) {
    state.rows.push(makeRow(state, undefined, right, rules, '自动补齐右侧新增内容'));
    state.rightIndex += 1;
    return 1;
  }
  if (!right) {
    state.rows.push(makeRow(state, left, undefined, rules, '自动标记左侧缺失内容'));
    state.leftIndex += 1;
    return 1;
  }

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
      id: rowId(state, left, right),
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
    return 2;
  }
  if (nextRightRatio > ratio && nextRightRatio > nextLeftRatio) {
    state.rows.push(makeRow(state, undefined, right, rules, '右侧有段落或句子插入'));
    state.rightIndex += 1;
  } else {
    state.rows.push(makeRow(state, left, undefined, rules, '左侧有段落或句子缺失'));
    state.leftIndex += 1;
  }
  return 1;
}

/** 执行固定一批（最多 ALIGN_BATCH_SIZE 个句段），同步完成，异常交由上层重试 */
function alignBatch(state: AlignmentCursor, leftUnits: TextUnit[], rightUnits: TextUnit[], rules: ComparisonRules) {
  let consumed = 0;
  while (consumed < ALIGN_BATCH_SIZE && !isAlignmentDone(state, leftUnits, rightUnits)) {
    consumed += alignOneStep(state, leftUnits, rightUnits, rules);
  }
}

/** 正文指纹：djb2 哈希 + 字符长度，输入一改即作废旧任务 */
function hashText(text: string): string {
  const chars = Array.from(text);
  let hash = 5381;
  for (const character of chars) {
    hash = ((hash << 5) + hash + character.codePointAt(0)!) >>> 0;
  }
  return `h${hash.toString(36)}-${chars.length}`;
}

function makeFingerprint(left: VersionDocument, right: VersionDocument, rules: ComparisonRules): AlignmentFingerprint {
  return {
    leftVersionId: left.id,
    rightVersionId: right.id,
    leftTextHash: hashText(left.text),
    rightTextHash: hashText(right.text),
    rules: clone(rules)
  };
}

function sameRules(a: ComparisonRules, b: ComparisonRules) {
  return (
    a.ignorePunctuation === b.ignorePunctuation &&
    a.ignoreVariants === b.ignoreVariants &&
    a.candidateWindow === b.candidateWindow
  );
}

function sameFingerprint(a: AlignmentFingerprint, b: AlignmentFingerprint) {
  return (
    a.leftVersionId === b.leftVersionId &&
    a.rightVersionId === b.rightVersionId &&
    a.leftTextHash === b.leftTextHash &&
    a.rightTextHash === b.rightTextHash &&
    sameRules(a.rules, b.rules)
  );
}

function pairKey(row: AlignmentRow) {
  return `${row.left?.id ?? ''}|${row.right?.id ?? ''}`;
}

function defaultRules(): ComparisonRules {
  return { ignorePunctuation: true, ignoreVariants: true, candidateWindow: 3 };
}

interface ActiveRun {
  serial: number;
  cancelled: boolean;
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
  const history = ref<AlignmentRow[][]>([]);
  const future = ref<AlignmentRow[][]>([]);
  /** 分批对齐断点：运行中、中断、三次异常停止时都可能存在 */
  const checkpoint = ref<AlignmentCheckpoint | null>(null);
  /** 当前持久化实际使用的降级等级，0 为完整保存 */
  const storageDegraded = ref<StorageDegradedLevel>(0);
  /** 容量不足或无法保存时给用户的提示 */
  const storageWarning = ref('');
  const canUndo = computed(() => history.value.length > 0);
  const canRedo = computed(() => future.value.length > 0);
  const leftVersion = computed(() => versions.value.find((item) => item.id === leftVersionId.value));
  const rightVersion = computed(() => versions.value.find((item) => item.id === rightVersionId.value));
  const selectedRow = computed(() => rows.value.find((item) => item.id === selectedRowId.value));
  const differenceCount = computed(() => rows.value.filter((row) => row.status !== 'same').length);
  const acceptedCount = computed(() => rows.value.filter((row) => row.accepted).length);
  const unresolvedCount = computed(() => rows.value.filter((row) => !row.accepted && row.status !== 'same').length);
  const estimatedBatches = computed(() => {
    const total = (leftVersion.value?.units.length ?? 0) + (rightVersion.value?.units.length ?? 0);
    return Math.max(1, Math.ceil(total / ALIGN_BATCH_SIZE));
  });
  const failedCheckpoint = computed(() =>
    checkpoint.value && checkpoint.value.status === 'failed' && !processing.value ? checkpoint.value : null
  );

  let activeRun: ActiveRun | null = null;
  let runSerial = 0;

  /** 按降级等级构造可落盘数据：等级越高越精简，丢弃的内容都能从版本正文重算。
   *  句段缓存可能因数据异常而无法序列化，此时只丢句段（恢复时从正文重算），不丢正文与校记。 */
  function buildStorage(level: StorageDegradedLevel): string {
    const tryClone = <T,>(value: T): T | undefined => {
      try {
        return clone(value);
      } catch {
        return undefined;
      }
    };

    // 逐版本判断句段缓存是否可序列化；不行就只存版本元数据与正文
    const safeVersions: VersionDocument[] = versions.value.map((version) => {
      const clonedUnits = level >= 3 ? undefined : tryClone(version.units);
      return {
        id: version.id,
        name: version.name,
        source: version.source,
        createdAt: version.createdAt,
        text: version.text,
        units: clonedUnits ?? []
      };
    });

    // 校勘行里的句段引用同理：引用缓存损坏时只丢句段，行本身（校记、接受判断）保留
    const safeRows: AlignmentRow[] = (() => {
      const cloned = tryClone(rows.value);
      if (cloned) return cloned;
      return rows.value.map((row) => ({
        ...row,
        left: tryClone(row.left),
        right: tryClone(row.right)
      })) as AlignmentRow[];
    })();

    // 断点包含尚未处理的句段，可能无法整体克隆；失败则不落断点（视为 1 级降级）
    let safeCheckpoint: AlignmentCheckpoint | null = null;
    let effectiveLevel: StorageDegradedLevel = level;
    if (level === 0) {
      safeCheckpoint = tryClone(checkpoint.value) ?? null;
      if (checkpoint.value && !safeCheckpoint) effectiveLevel = 1;
    }

    const state: PersistedCollationState = {
      versions: safeVersions,
      leftVersionId: leftVersionId.value,
      rightVersionId: rightVersionId.value,
      rows: safeRows,
      rules: clone(rules.value),
      selectedRowId: selectedRowId.value,
      checkpoint: effectiveLevel === 0 ? safeCheckpoint : null,
      storageDegraded: effectiveLevel
    };
    if (level >= 2) {
      const strip = (unit: TextUnit) => {
        delete unit.paragraphText;
      };
      state.versions.forEach((version) => version.units.forEach(strip));
      state.rows.forEach((row) => {
        row.left && strip(row.left);
        row.right && strip(row.right);
      });
    }
    return JSON.stringify(state);
  }

  /** 逐级降级写入 localStorage，容量不足时提示用户 */
  function persist() {
    const levels: StorageDegradedLevel[] = [0, 1, 2, 3];
    let lastError: unknown = null;
    for (const level of levels) {
      try {
        localStorage.setItem(STORAGE_KEY, buildStorage(level));
        if (level > 0) {
          storageDegraded.value = level;
          storageWarning.value =
            level === 1
              ? '本地存储容量不足，已降级保存：版本、校记和接受判断完好，但本次对齐断点未能保存。'
              : '本地存储容量不足，已降级保存：省略的句段缓存会在重开时从版本正文重算，建议尽快导出 JSON 备份。';
        } else {
          storageDegraded.value = 0;
        }
        return;
      } catch (error) {
        lastError = error;
      }
    }
    storageWarning.value = '本地存储空间不足，本次改动未能保存，请导出 JSON 校勘数据后清理浏览器存储。';
    throw lastError instanceof Error ? lastError : new Error('本地存储不可用');
  }

  /** 校勘行快照（撤销/重做只回滚校勘内容，不触碰版本、规则与对齐任务） */
  function rowsSnapshot(): AlignmentRow[] {
    return clone(rows.value);
  }

  function commit(label: string, mutate: () => void) {
    history.value.push(rowsSnapshot());
    if (history.value.length > 50) history.value.shift();
    future.value = [];
    mutate();
    message.value = label;
    persist();
  }

  function restore(raw: string) {
    const parsed = JSON.parse(raw) as PersistedCollationState;
    const degraded = parsed.storageDegraded ?? 0;
    // 降级保存时句段被省略或剥离了段内原文，统一按版本正文确定性重算并按 id 接回
    const needsRebuild =
      degraded >= 2 || parsed.versions.some((version) => version.units.some((unit) => unit.paragraphText === undefined));
    if (needsRebuild) {
      const unitIndex = new Map<string, TextUnit>();
      parsed.versions.forEach((version) => {
        version.units = splitIntoUnits(version.text, version.id);
        version.units.forEach((unit) => unitIndex.set(unit.id, unit));
      });
      const repair = (unit?: TextUnit) => (unit ? unitIndex.get(unit.id) ?? unit : unit);
      parsed.rows.forEach((row) => {
        row.left = repair(row.left);
        row.right = repair(row.right);
      });
      parsed.checkpoint?.partialRows.forEach((row) => {
        row.left = repair(row.left);
        row.right = repair(row.right);
      });
    }
    versions.value = parsed.versions;
    leftVersionId.value = parsed.leftVersionId;
    rightVersionId.value = parsed.rightVersionId;
    rows.value = parsed.rows;
    rules.value = parsed.rules;
    selectedRowId.value = parsed.selectedRowId;
    checkpoint.value = parsed.checkpoint ?? null;
    storageDegraded.value = degraded;
    persist();
  }

  function undo() {
    const previous = history.value.pop();
    if (!previous) return;
    future.value.push(rowsSnapshot());
    rows.value = previous;
    selectedRowId.value = previous[0]?.id ?? '';
    selectedRowIds.value = [];
    message.value = '已撤销上一步操作';
    persist();
  }

  function redo() {
    const next = future.value.pop();
    if (!next) return;
    history.value.push(rowsSnapshot());
    rows.value = next;
    selectedRowId.value = next[0]?.id ?? '';
    selectedRowIds.value = [];
    message.value = '已重做上一步操作';
    persist();
  }

  function currentFingerprint(): AlignmentFingerprint | null {
    if (!leftVersion.value || !rightVersion.value) return null;
    return makeFingerprint(leftVersion.value, rightVersion.value, rules.value);
  }

  /** 输入若已变化，作废正在执行的任务与旧断点：迟到结果一律不得写进校勘行 */
  function invalidateStaleJob() {
    const cp = checkpoint.value;
    const expected = currentFingerprint();
    if (cp && expected && !sameFingerprint(cp.fingerprint, expected)) {
      if (activeRun) activeRun.cancelled = true;
      checkpoint.value = null;
      if (processing.value) {
        message.value = '底本、参校本、比较规则或正文已变更，对齐任务立即作废，迟到结果不会写入校勘行';
      }
      return true;
    }
    return false;
  }

  /** 把新对齐结果与旧行按「底本句 + 参校本句」配对，沿用已保存的校记、来源与接受判断 */
  function mergeWithSavedAnnotations(newRows: AlignmentRow[]) {
    const previous = new Map<string, AlignmentRow>();
    rows.value.forEach((row) => previous.set(pairKey(row), row));
    return newRows.map((row) => {
      const old = previous.get(pairKey(row));
      if (!old) return row;
      const carried: Partial<AlignmentRow> = {
        note: old.note,
        source: old.source,
        accepted: old.accepted
      };
      // 人工调整过的类别也保留，自动结果不覆盖人工判断
      if (old.manuallyAdjusted) {
        carried.manuallyAdjusted = true;
        carried.status = old.status;
        carried.similarity = old.similarity;
      }
      return { ...row, ...carried };
    });
  }

  /**
   * 执行分批对齐主循环：
   * - 每个 await 之后核对运行代号与输入指纹，作废任务的迟到结果不写行；
   * - 同批异常重试，连续 3 次失败即停止并说明原因、保留断点；
   * - 周期性把断点写入 localStorage，关页面时由 flushCheckpoint 补写。
   */
  async function executeJob(cp: AlignmentCheckpoint, commitHistory: boolean) {
    const run: ActiveRun = { serial: ++runSerial, cancelled: false };
    activeRun = run;
    processing.value = true;
    const startBatches = cp.batchesDone;
    message.value =
      cp.batchesDone > 0 ? `正在从第 ${cp.batchesDone + 1} 批断点继续对齐…` : '正在分批执行自动对齐…';

    const left = leftVersion.value;
    const right = rightVersion.value;
    if (!left || !right) {
      processing.value = false;
      activeRun = null;
      return;
    }
    const leftUnits = left.units;
    const rightUnits = right.units;
    // 历史快照延迟到首批成功后再拍：任务若在第一批就三次失败，不产生撤销步骤
    let previousRowsSnapshot: AlignmentRow[] | null = null;
    let snapshotTaken = false;
    const previousSelected = selectedRowId.value;

    try {
      while (!isAlignmentDone(cp, leftUnits, rightUnits)) {
        const expected = currentFingerprint();
        if (run.cancelled || !expected || !sameFingerprint(cp.fingerprint, expected)) {
          checkpoint.value = null;
          try {
            persist();
          } catch {
            /* 保存失败提示已在 persist 中设置 */
          }
          return;
        }

        // 每批从断点游标拷贝一个工作副本（行数组必须复制：批内 push 不能污染断点）；
        // 本批失败重试时丢弃副本中的半截结果，保证失败尝试不残留、最终行数与一次跑成一致
        let state: AlignmentCursor = {
          rows: cp.partialRows.slice(),
          leftIndex: cp.leftIndex,
          rightIndex: cp.rightIndex
        };
        let attempt = 0;
        let batchOk = false;
        let lastError: unknown = null;
        while (attempt < MAX_BATCH_FAILURES && !batchOk) {
          if (run.cancelled) break;
          try {
            alignBatch(state, leftUnits, rightUnits, cp.fingerprint.rules);
            batchOk = true;
          } catch (error) {
            attempt += 1;
            lastError = error;
            cp.failureCount = attempt;
            cp.error = error instanceof Error ? error.message : String(error);
            // 回滚到本批开始前的游标后再重试，避免半截行累积
            state = {
              rows: cp.partialRows.slice(),
              leftIndex: cp.leftIndex,
              rightIndex: cp.rightIndex
            };
            if (attempt < MAX_BATCH_FAILURES) {
              await yieldToBrowser();
            }
          }
        }

        if (run.cancelled) {
          checkpoint.value = null;
          try {
            persist();
          } catch {
            /* ignore */
          }
          return;
        }

        if (!batchOk) {
          // 三次异常：停下、说明原因、保留未完成片，等待用户从断点继续
          cp.status = 'failed';
          cp.error = lastError instanceof Error ? lastError.message : String(lastError);
          cp.updatedAt = new Date().toISOString();
          checkpoint.value = { ...cp };
          progress.value = Math.round(
            ((cp.leftIndex + cp.rightIndex) / Math.max(1, leftUnits.length + rightUnits.length)) * 100
          );
          message.value = `自动对齐在第 ${cp.batchesDone + 1} 批连续三次异常，已停止：${cp.error}。可从断点重试本片。`;
          try {
            persist();
          } catch {
            // 异常可能源自待序列化数据本身损坏：只落盘可安全序列化的校勘内容，失败断点保留在内存
            storageWarning.value = '本地保存失败，可能是正文或句段数据异常；失败断点保留在当前页面，请修复后从断点继续。';
            try {
              localStorage.setItem(
                STORAGE_KEY,
                JSON.stringify({
                  versions: versions.value.map((version) => ({ ...version, units: [] })),
                  leftVersionId: leftVersionId.value,
                  rightVersionId: rightVersionId.value,
                  rows: rows.value,
                  rules: rules.value,
                  selectedRowId: selectedRowId.value,
                  checkpoint: null,
                  storageDegraded: 3
                } satisfies PersistedCollationState)
              );
            } catch {
              /* 存储彻底不可用，仅保留内存状态 */
            }
          }
          return;
        }

        cp.partialRows = state.rows;
        cp.leftIndex = state.leftIndex;
        cp.rightIndex = state.rightIndex;
        cp.batchesDone += 1;
        cp.failureCount = 0;
        cp.error = undefined;
        cp.status = 'running';
        cp.updatedAt = new Date().toISOString();
        checkpoint.value = { ...cp };
        if (!snapshotTaken && commitHistory) {
          previousRowsSnapshot = rowsSnapshot();
          snapshotTaken = true;
        }
        progress.value = Math.round(
          ((cp.leftIndex + cp.rightIndex) / Math.max(1, leftUnits.length + rightUnits.length)) * 100
        );

        if (isAlignmentDone(cp, leftUnits, rightUnits) || (cp.batchesDone - startBatches) % CHECKPOINT_SAVE_EVERY === 0) {
          try {
            persist();
          } catch {
            /* 容量提示已记录，继续内存执行 */
          }
        }
        await yieldToBrowser();
      }

      // 完成前再核对一次：作废任务的结果绝不写入
      const expected = currentFingerprint();
      if (run.cancelled || !expected || !sameFingerprint(cp.fingerprint, expected)) {
        checkpoint.value = null;
        try {
          persist();
        } catch {
          /* ignore */
        }
        return;
      }

      const merged = mergeWithSavedAnnotations(cp.partialRows);
      if (snapshotTaken && previousRowsSnapshot) {
        history.value.push(previousRowsSnapshot);
        if (history.value.length > 50) history.value.shift();
        future.value = [];
      }
      rows.value = merged;
      selectedRowId.value =
        merged.find((row) => row.status !== 'same' && !row.accepted)?.id ??
        merged.find((row) => row.status !== 'same')?.id ??
        previousSelected ??
        merged[0]?.id ??
        '';
      selectedRowIds.value = [];
      checkpoint.value = null;
      progress.value = 100;
      message.value = `自动对齐完成：${merged.filter((row) => row.status !== 'same').length} 处差异；已保存的校记和接受判断均已沿用`;
      persist();
    } finally {
      if (activeRun?.serial === run.serial) {
        activeRun = null;
        processing.value = false;
      }
    }
  }

  /** 用户手动发起：按当前输入记录指纹，从第 0 批开始全新对齐 */
  async function runAlignment() {
    if (!leftVersion.value || !rightVersion.value || processing.value) return;
    if (activeRun) activeRun.cancelled = true;
    checkpoint.value = {
      fingerprint: makeFingerprint(leftVersion.value, rightVersion.value, rules.value),
      status: 'running',
      partialRows: [],
      leftIndex: 0,
      rightIndex: 0,
      batchesDone: 0,
      failureCount: 0,
      updatedAt: new Date().toISOString()
    };
    progress.value = 0;
    await executeJob(checkpoint.value, true);
  }

  /** 从断点继续：指纹仍有效才允许，失败三次后可重试当前片 */
  async function resumeAlignment() {
    const cp = checkpoint.value;
    if (!cp || processing.value) return;
    const expected = currentFingerprint();
    if (!expected || !sameFingerprint(cp.fingerprint, expected)) {
      checkpoint.value = null;
      message.value = '底本、参校本、规则或正文已变更，旧断点已作废，请重新发起对齐';
      persist();
      return;
    }
    cp.status = 'running';
    cp.failureCount = 0;
    cp.error = undefined;
    checkpoint.value = { ...cp };
    await executeJob(cp, true);
  }

  /** 关页面 / 切后台时同步补写断点，重开后可从最近未完成片接上 */
  function flushCheckpoint() {
    const cp = checkpoint.value;
    if (cp && cp.status === 'running' && activeRun) {
      cp.status = 'interrupted';
      cp.updatedAt = new Date().toISOString();
      checkpoint.value = { ...cp };
      try {
        // 走统一的逐级降级；容量不足时即使丢掉断点，版本与校记也已保存
        persist();
      } catch {
        /* 浏览器即将关闭，无法再提示 */
      }
    }
  }

  window.addEventListener('pagehide', flushCheckpoint);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushCheckpoint();
  });

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
    void runAlignment();
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
      const cell = (value?: string) => (value ?? '').replaceAll('|', '\\|').replaceAll('\n', '');
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

  function dismissStorageWarning() {
    storageWarning.value = '';
  }

  onMounted(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        restore(raw);
        message.value = '已恢复浏览器中的校勘草稿';
      } else {
        message.value = '已载入示例版本，正在自动对齐…';
        void runAlignment();
        return;
      }
    } catch {
      message.value = '本地草稿读取失败，已载入示例数据';
      void runAlignment();
      return;
    }

    // 重开后处理断点：指纹失效则作废；三次异常停止则保留现场等用户操作；其余从未完成片自动接上
    const cp = checkpoint.value;
    if (cp) {
      const expected = currentFingerprint();
      if (!expected || !sameFingerprint(cp.fingerprint, expected)) {
        checkpoint.value = null;
        message.value = '保存的对齐任务与当前底本、参校本、规则或正文不一致，旧断点已作废';
        persist();
      } else if (cp.status === 'failed') {
        message.value = `上次对齐在第 ${cp.batchesDone + 1} 批连续三次异常后停止（${cp.error ?? '未知原因'}），可从断点继续`;
      } else {
        message.value = `检测到未完成的对齐（已完成 ${cp.batchesDone} 批），正从断点继续…`;
        void resumeAlignment();
      }
    }
  });

  // 输入（底本/参校本选择、两版正文、规则）一变，正在进行的对齐立即作废；
  // 只按指纹依赖项监听：句段重切分（units）不影响指纹，不应误作废任务
  watch(
    [
      leftVersionId,
      rightVersionId,
      () => leftVersion.value?.text,
      () => rightVersion.value?.text,
      rules
    ],
    () => {
      invalidateStaleJob();
      if (!processing.value) persist();
    },
    { deep: true }
  );

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
    checkpoint,
    storageDegraded,
    storageWarning,
    estimatedBatches,
    failedCheckpoint,
    canUndo,
    canRedo,
    leftVersion,
    rightVersion,
    selectedRow,
    differenceCount,
    acceptedCount,
    unresolvedCount,
    runAlignment,
    resumeAlignment,
    dismissStorageWarning,
    persist,
    restore,
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
