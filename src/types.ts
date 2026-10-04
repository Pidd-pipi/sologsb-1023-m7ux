export type DifferenceStatus = 'same' | 'changed' | 'added' | 'removed' | 'misaligned';

export interface TextUnit {
  id: string;
  paragraphId: string;
  paragraphOrder: number;
  sentenceOrder: number;
  /** 降级保存时可能省略，可由所属版本正文重算 */
  paragraphText?: string;
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

/** 对齐任务启动时记录的输入指纹：底本、参校本、规则与正文任一改变即作废旧任务 */
export interface AlignmentFingerprint {
  leftVersionId: string;
  rightVersionId: string;
  leftTextHash: string;
  rightTextHash: string;
  rules: ComparisonRules;
}

export type AlignmentJobStatus = 'running' | 'interrupted' | 'failed' | 'done';

/** 分批对齐的断点：从未完成片继续所需的全部状态 */
export interface AlignmentCheckpoint {
  fingerprint: AlignmentFingerprint;
  status: AlignmentJobStatus;
  /** 已产出的行（断点片中的临时结果） */
  partialRows: AlignmentRow[];
  /** 下一批开始时底本句段下标 */
  leftIndex: number;
  /** 下一批开始时参校本句段下标 */
  rightIndex: number;
  /** 已完成批数 */
  batchesDone: number;
  /** 最近一次失败原因 */
  error?: string;
  /** 当前片已连续失败次数，达到 3 次停止 */
  failureCount: number;
  updatedAt: string;
}

/**
 * 容量不足时的持久化降级等级：
 * 0 完整保存；1 去掉断点；2 句段省略可重算的段内原文；3 只保留版本正文重算全部句段
 */
export type StorageDegradedLevel = 0 | 1 | 2 | 3;

export interface PersistedCollationState {
  versions: VersionDocument[];
  leftVersionId: string;
  rightVersionId: string;
  rows: AlignmentRow[];
  rules: ComparisonRules;
  selectedRowId: string;
  checkpoint?: AlignmentCheckpoint | null;
  storageDegraded?: StorageDegradedLevel;
}
