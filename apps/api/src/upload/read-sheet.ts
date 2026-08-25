import ExcelJS from 'exceljs';

/**
 * 업로드 파일(.xlsx · .csv)을 셀 행렬로 읽는다. 판정·검증은 하지 않는다 — 그건
 * `parseSchedule` 의 몫이고, 여기는 포맷만 벗겨 순수 파서에 넘긴다.
 *
 * xlsx 파싱은 유지보수되는 exceljs 를 쓴다. npm 의 `xlsx`(SheetJS)는 0.18.5 에 묶여
 * 프로토타입 오염·ReDoS 취약점이 남아 있어, 사용자 업로드를 파싱하는 데 쓰지 않는다.
 */

export type Cell = string | number | null;

export async function readSheetRows(buffer: Buffer, filename: string): Promise<Cell[][]> {
  if (filename.toLowerCase().endsWith('.csv')) {
    return parseCsv(buffer.toString('utf8'));
  }
  const wb = new ExcelJS.Workbook();
  // @types/node 22 의 Buffer 제네릭과 exceljs 의 Buffer 파라미터가 어긋난다 — load 가 받는
  // 타입으로 좁혀 넘긴다. 런타임 값은 그대로 Buffer 다.
  await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = wb.worksheets[0];
  if (ws === undefined) return [];

  const rows: Cell[][] = [];
  const colCount = Math.max(ws.columnCount, 1);
  ws.eachRow({ includeEmpty: true }, (row) => {
    const cells: Cell[] = [];
    for (let c = 1; c <= colCount; c++) {
      cells.push(row.getCell(c).text ?? '');
    }
    rows.push(cells);
  });
  return rows;
}

/** 최소 CSV 파서 — 따옴표 필드와 이스케이프(`""`)만 처리한다. 의존성을 더하지 않는다 */
function parseCsv(text: string): Cell[][] {
  const rows: Cell[][] = [];
  let field = '';
  let row: Cell[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
