export function parseCSVPreview(csvText: string, maxRows: number = 5): string[][] {
  const lines = csvText.split(/\r?\n/).filter(line => line.trim().length > 0);
  const result: string[][] = [];
  
  for (let i = 0; i < Math.min(lines.length, maxRows + 1); i++) {
    const line = lines[i];
    const row: string[] = [];
    let current = '';
    let inQuotes = false;
    
    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      
      if (char === '"') {
        if (inQuotes && line[j + 1] === '"') {
          current += '"';
          j++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        row.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    row.push(current);
    result.push(row);
  }
  
  return result;
}
