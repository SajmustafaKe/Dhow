import { describe, expect, it } from 'vitest'
import { getDataImportCardData, getDataProvenanceCardData, type ToolCall } from './chat-conversation'

const baseTool = (overrides: Partial<ToolCall>): ToolCall => ({
  id: 't1',
  name: 'data-import',
  input: {},
  status: 'completed',
  timestamp: Date.now(),
  ...overrides,
})

describe('getDataImportCardData', () => {
  it('returns null for non-data-import tools', () => {
    expect(getDataImportCardData(baseTool({ name: 'data-ask' }))).toBeNull()
  })

  it('returns null when the import failed', () => {
    const tool = baseTool({ result: { success: false, error: 'nope' } })
    expect(getDataImportCardData(tool)).toBeNull()
  })

  it('extracts imported and skipped profiles on success', () => {
    const tool = baseTool({
      result: {
        success: true,
        imported: [
          { table: 'q1_sales', rowCount: 124, sourcePath: '/tmp/q1.csv', columns: [{ name: 'region', type: 'TEXT' }] },
        ],
        skipped: [{ sheet: 'Cover', reason: 'no tabular data' }],
      },
    })
    const data = getDataImportCardData(tool)
    expect(data).not.toBeNull()
    expect(data?.imported).toHaveLength(1)
    expect(data?.imported[0].table).toBe('q1_sales')
    expect(data?.imported[0].rowCount).toBe(124)
    expect(data?.skipped).toEqual([{ sheet: 'Cover', reason: 'no tabular data' }])
  })

  it('defaults imported and skipped to empty arrays when absent', () => {
    const tool = baseTool({ result: { success: true } })
    const data = getDataImportCardData(tool)
    expect(data).toEqual({ imported: [], skipped: [] })
  })
})

describe('getDataProvenanceCardData', () => {
  it('returns null for tools other than data-ask/data-sql', () => {
    expect(getDataProvenanceCardData(baseTool({ name: 'data-import' }))).toBeNull()
  })

  it('extracts provenance fields for a successful data-ask call', () => {
    const tool = baseTool({
      name: 'data-ask',
      result: {
        success: true,
        rowCount: 3,
        truncated: false,
        provenance: 'Scanned q1_sales (124 rows). SQL: SELECT region, sum(amount)...',
      },
    })
    const data = getDataProvenanceCardData(tool)
    expect(data?.rowCount).toBe(3)
    expect(data?.truncated).toBe(false)
    expect(data?.provenance).toContain('Scanned q1_sales')
  })

  it('falls back to lastSql and surfaces the error on a failed data-ask call', () => {
    const tool = baseTool({
      name: 'data-ask',
      status: 'error',
      result: {
        success: false,
        error: 'Could not produce a working query.',
        attempts: 2,
        lastSql: 'SELECT * FROM nope',
      },
    })
    const data = getDataProvenanceCardData(tool)
    expect(data?.error).toBe('Could not produce a working query.')
    expect(data?.attempts).toBe(2)
    expect(data?.sql).toBe('SELECT * FROM nope')
  })

  it('extracts sql, rowCount, and elapsedMs for data-sql', () => {
    const tool = baseTool({
      name: 'data-sql',
      result: {
        success: true,
        sql: 'SELECT sum(amount) FROM q1_sales',
        rowCount: 1,
        truncated: false,
        elapsedMs: 12,
      },
    })
    const data = getDataProvenanceCardData(tool)
    expect(data?.sql).toBe('SELECT sum(amount) FROM q1_sales')
    expect(data?.elapsedMs).toBe(12)
  })
})
