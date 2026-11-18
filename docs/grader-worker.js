import { commands } from './vendor/clang/bundle.js';
import { WASI, File, OpenFile, ConsoleStdout } from './vendor/wasi/index.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const marker = '__C_LAB_TESTS_PASSED__';
const maxOutput = 8192;
let tests;

function collect() {
    const bytes = new Uint8Array(maxOutput);
    let length = 0;
    return {
        write(chunk) {
            if (!chunk) return;
            const part = chunk.subarray(0, maxOutput - length);
            bytes.set(part, length);
            length += part.length;
        },
        text: () => decoder.decode(bytes.subarray(0, length))
    };
}

async function run(module, args = ['check'], input = '') {
    const stdout = collect();
    const stderr = collect();
    const wasi = new WASI(args, [], [
        new OpenFile(new File(encoder.encode(input))),
        new ConsoleStdout(stdout.write),
        new ConsoleStdout(stderr.write)
    ]);
    const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
    const status = wasi.start(instance);
    return { status, output: stdout.text(), detail: stderr.text() };
}

function testFailure(cases, index, detail = '') {
    return { ok: false, message: 'Не пройден тест — ' + cases[index - 1], detail };
}

function matchesFilter(lines) {
    const expected = [[2, -8], [-48, 2, -8, 20, 100], [], [-48, 17, 20, 33]];
    if (lines.length !== expected.length) return false;
    return lines.every((line, i) => {
        const values = line.replace(/^Отфильтрованные элементы:/, '').trim();
        if (!/^(?:-?\d+(?:\s+-?\d+)*)?$/.test(values)) return false;
        const numbers = values === '' ? [] : values.split(/\s+/).map(Number);
        return numbers.length === expected[i].length &&
            numbers.every((value, j) => value === expected[i][j]);
    });
}

export async function grade(exercise, source, onPhase = () => {}) {
    tests ??= fetch(new URL('./tests.json', import.meta.url)).then(response => {
        if (!response.ok) throw new Error('Не удалось загрузить тесты.');
        return response.json();
    }).catch(error => { tests = undefined; throw error; });
    const { code, cases } = (await tests)[exercise];
    const diagnostics = collect();
    let files;
    try {
        files = await commands.clang(
            ['-std=c17', '-Werror=return-type', 'harness.c', '-o', 'check.wasm', '-lm',
             '-Wl,--max-memory=16777216'],
            { 'student.c': source, 'harness.c': code },
            { stderr: diagnostics.write, stdout: diagnostics.write, fetchProgress: () => {} }
        );
    } catch (error) {
        const detail = diagnostics.text();
        if (detail) return { ok: false, message: 'Ошибка компиляции или сборки.', detail };
        throw error;
    }

    const module = await WebAssembly.compile(files['check.wasm']);
    onPhase('run');
    let result;
    try {
        result = await run(module);
    } catch (error) {
        return { ok: false, message: 'Программа завершилась с ошибкой.', detail: error.message };
    }
    const failed = result.status - 20;
    if (failed >= 1 && failed <= cases.length) return testFailure(cases, failed, result.detail);
    if (result.status !== 0) {
        return { ok: false, message: 'Программа завершилась с ошибкой.', detail: result.detail };
    }
    const lines = result.output.replace(/\r/g, '').trimEnd().split('\n');
    if (lines.pop() !== marker) return { ok: false, message: 'Программа завершилась до конца тестов.' };
    if (exercise === 5 && !matchesFilter(lines)) return testFailure(cases, 4, result.output);

    if (exercise === 3) {
        for (const [input, expected] of [['4 2 5\n', 32], ['1 -4 7\n', -11]]) {
            const menu = await run(module, ['check', 'menu'], input);
            const match = menu.output.match(/(?<![\w.+-])-?\d{1,10}\s*$/);
            if (menu.status !== 0 || !match || Number(match[0]) !== expected) {
                return testFailure(cases, 6, menu.output + menu.detail);
            }
        }
    }
    return { ok: true, message: 'Пройдено тестов: ' + cases.length + ' из ' + cases.length + '.', tests: cases };
}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
    self.onmessage = async ({ data: { exercise, source } }) => {
        try {
            const result = await grade(exercise, source, phase => self.postMessage({ phase }));
            self.postMessage({ result });
        } catch (error) {
            self.postMessage({ error: 'Не удалось запустить проверку. Обнови страницу и попробуй ещё раз.', detail: error.message });
        }
    };
}
