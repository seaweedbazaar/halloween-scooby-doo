// Card printing through the Windows printer driver (see scripts/print-card.ps1)
import { execFile } from 'node:child_process';
import path from 'node:path';

const run = (args) => new Promise((resolve, reject) => {
  execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { timeout: 60_000, windowsHide: true },
    (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim().split(/\r?\n/)[0])) : resolve(stdout.trim())));
});

export async function listPrinters() {
  const out = await run(['-Command', 'Get-Printer | Select-Object -ExpandProperty Name | ConvertTo-Json']);
  const names = out ? JSON.parse(out) : [];
  return Array.isArray(names) ? names : [names];
}

// printer: Windows printer name ('' = PRINTER_NAME from .env, else the Windows default)
// paper: part of the driver's paper size name (PRINT_PAPER), ignored for test prints to a file
export function printCard(imagePath, { printer = process.env.PRINTER_NAME || '', fill = process.env.PRINT_FILL === 'true', paper = process.env.PRINT_PAPER || '', rotate180 = false, copies = 1, outFile } = {}) {
  const args = ['-File', path.resolve('scripts/print-card.ps1'), '-Image', path.resolve(imagePath)];
  if (printer) args.push('-Printer', printer);
  if (paper && !outFile) args.push('-Paper', paper);
  if (rotate180) args.push('-Rotate180');
  if (fill) args.push('-Fill');
  if (copies > 1) args.push('-Copies', String(copies));
  if (outFile) args.push('-OutFile', outFile);
  return run(args);
}
