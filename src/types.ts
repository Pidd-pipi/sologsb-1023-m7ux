export type DifferenceStatus = 'same' | 'changed' | 'added' | 'removed' | 'misaligned';

export interface TextUnit {
  id: string;
  paragraphId: string;
  paragraphOrder: number;
  sentenceOrder: number;
  paragraphText: string;
  text: string;
}

export interface VersionDocument {
  id: string;
  name: string;
  source: string;
  createdAt: string;
  text: string;
  units: TextUnit[];
}

export interface AlignmentRow {
  id: string;
  left?: TextUnit;
  right?: TextUnit;
  status: DifferenceStatus;
  similarity: number;
  note: string;
  source: string;
  accepted: boolean;
  manuallyAdjusted: boolean;
}

export interface ComparisonRules {
  ignorePunctuation: boolean;
  ignoreVariants: boolean;
  candidateWindow: number;
}

/** 对齐任务状态：运行中 / 已完成 / 已失败（三次异常）/ 已作废（输入变更） */
export type TaskStatus = 'running' | 'done' | 'failed' | 'invalid';

/** 任务启动时记录的输入清单，用于作废判定 */
export interface TaskManifest {
  leftVersionId: string;
  rightVersionId: string;
  rules: ComparisonRules;
  /** 底本 + 参校本正文与规则的指纹 */
  fingerprint: string;
}

/** 可分片 checkpoint 的对齐任务 */
export interface AlignmentTask {
  id: string;
  manifest: TaskManifest;
  status: TaskStatus;
  totalUnits: number;
  processedUnits: number;
  leftIndex: number;
  rightIndex: number;
  rows: AlignmentRow[];
  errorCount: number;
  lastError?: string;
  batchSize: number;
  startedAt: string;
  updatedAt: string;
}

/** 持久化用的精简行：只存单元 id 与人工字段，避免正文重复存储撑爆容量 */
export interface PersistedRow {
  id: string;
  leftId: string | null;
  rightId: string | null;
  status: DifferenceStatus;
  similarity: number;
  note: string;
  source: string;
  accepted: boolean;
  manuallyAdjusted: boolean;
}

/** 持久化用的精简任务 */
export interface PersistedTask extends Omit<AlignmentTask, 'rows'> {
  rows: PersistedRow[];
}

export interface PersistedCollationState {
  versions: VersionDocument[];
  leftVersionId: string;
  rightVersionId: string;
  rows: PersistedRow[];
  rules: ComparisonRules;
  selectedRowId: string;
  /** 容量不足时降级保存的标记 */
  storageDegraded?: boolean;
}
