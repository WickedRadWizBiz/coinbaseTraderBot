"""GPU prototype of the SNN column step (python/snn/column.cu, column_par.cuh): parity and speed.

Reads a kernel trace (research/snnKernel.ts recordKernelTrace: every column's state before its first step, every
call the TypeScript network made to Column.step, every column's state after), copies each column into M tournament
members, runs all members' columns through the recorded calls on the GPU, and checks that every member ends on
exactly the TypeScript network's bits. Then times it for several population sizes, with both kernels:

    thread   one GPU thread per member x column (column.cu snn_columns_run): each runs a whole column alone
    block    one thread block per member x column (column_par.cuh snn_columns_run_par): its neurons, branches and
             synapses spread over the block's threads

    python bench.py <trace> [--members 1,8,32,64,128,256] [--threads 64] [--cpu] [--json out.json]

The GPU build uses PyTorch's runtime CUDA compiler (torch.cuda._compile_kernel, NVRTC) with fused multiply-add
off, so nothing beyond the trainer's PyTorch is needed. --cpu runs the same C source through a shared library
compiled with the system C compiler (the layout check this repository's tests run without a GPU).
"""

import ctypes
import json
import os
import struct
import subprocess
import sys
import tempfile
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DT = [np.float64, np.float32, np.int32, np.uint8]
N_SLOTS = 80  # Col: 57 double, 3 uint8, 7 float, 11 int, sc, si pointers
STEPIN = np.dtype([('price', '<f8'), ('mid', '<f8'), ('latInh', '<f8'), ('dBrier', '<f8'), ('refRateE', '<f8'),
                   ('first', '<i4'), ('frozen', '<i4'), ('kind', '<i4'), ('pad', '<i4'), ('vals', '<u8'), ('gapV', '<u8')])
assert STEPIN.itemsize == 72


class Reader:
    def __init__(self, data):
        self.b, self.i = data, 0

    def take(self, n):
        out = self.b[self.i:self.i + n]
        if len(out) < n:
            raise ValueError('trace ends early')
        self.i += n
        return out

    def u32(self):
        return struct.unpack('<I', self.take(4))[0]

    def i32(self):
        return struct.unpack('<i', self.take(4))[0]

    def f64(self):
        return struct.unpack('<d', self.take(8))[0]

    def typed(self):
        dt, n = self.u32(), self.u32()
        return np.frombuffer(self.take(n * np.dtype(DT[dt]).itemsize), dtype=DT[dt]).copy()


def parse_trace(path):
    r = Reader(open(path, 'rb').read())
    if r.take(4) != b'SNNK' or r.u32() != 1:
        raise ValueError(f'{path}: not a kernel trace (version 1)')
    cols = []
    for _ in range(r.u32()):
        ni = r.u32(); ints = r.take(4 * ni)
        nd = r.u32(); dbls = r.take(8 * nd)
        na = r.u32()
        if na != N_SLOTS:
            raise ValueError(f'column has {na} arrays, the kernel {N_SLOTS}')
        cols.append({'params': ints + dbls, 'init': [r.typed() for _ in range(na)], 'ops': []})
    for _ in range(r.u32()):
        op, c = r.u32(), r.u32()
        if op == 1:
            cols[c]['ops'].append({'kind': 2})
            continue
        first, frozen = r.i32(), r.i32()
        price, mid, lat, dbr, ref = (r.f64() for _ in range(5))
        vals = r.typed()
        gap = r.typed() if r.u32() else None
        cols[c]['ops'].append({'kind': 1, 'first': first, 'frozen': frozen, 'price': price, 'mid': mid, 'latInh': lat,
                               'dBrier': dbr, 'refRateE': ref, 'vals': vals, 'gapV': gap})
    for c in cols:
        c['final'] = [r.typed() for _ in range(N_SLOTS)]
    return cols


def layout(cols, members):
    """Host buffers for M members x C columns: one state blob (every array 8-aligned), its offsets per thread and slot,
    the params, the per-round inputs (members share their column's) and the vals/gap blob."""
    C = len(cols)
    n = members * C
    col_of = np.array([t % C for t in range(n)], dtype=np.int32)
    p_idx = col_of.copy()
    offs = np.zeros((n, N_SLOTS), dtype=np.uint64)
    pos = 0
    for t in range(n):
        for k, a in enumerate(cols[col_of[t]]['init']):
            offs[t, k] = pos
            pos += (a.nbytes + 7) // 8 * 8
    state = np.zeros(pos, dtype=np.uint8)
    for t in range(n):
        for k, a in enumerate(cols[col_of[t]]['init']):
            o = int(offs[t, k])
            state[o:o + a.nbytes] = a.view(np.uint8)
    params = np.frombuffer(b''.join(c['params'] for c in cols), dtype=np.uint8).copy()
    psize = len(cols[0]['params'])
    rounds = max(len(c['ops']) for c in cols)
    ins = np.zeros(rounds * C, dtype=STEPIN)
    blob = bytearray()
    voff = np.zeros(rounds * C, dtype=np.int64) - 1
    goff = np.zeros(rounds * C, dtype=np.int64) - 1
    for c, col in enumerate(cols):
        for r, op in enumerate(col['ops']):
            e = ins[r * C + c]
            e['kind'] = op['kind']
            if op['kind'] != 1:
                continue
            for f in ('price', 'mid', 'latInh', 'dBrier', 'refRateE', 'first', 'frozen'):
                e[f] = op[f]
            voff[r * C + c] = len(blob); blob += op['vals'].tobytes()
            if op['gapV'] is not None:
                goff[r * C + c] = len(blob); blob += op['gapV'].tobytes()
    return {'n': n, 'C': C, 'rounds': rounds, 'col_of': col_of, 'p_idx': p_idx, 'offs': offs, 'state': state, 'params': params,
            'psize': psize, 'ins': ins, 'blob': np.frombuffer(bytes(blob) or b'\0' * 8, dtype=np.uint8).copy(), 'voff': voff, 'goff': goff,
            'dims': [dims(c) for c in cols]}


SLOT_FF_PTR, SLOT_REC_PTR = 68, 70  # Col: ffPtr, recPtr


def dims(col):
    """(N, feedforward synapses, recurrent synapses) of a column, for the block kernel's scratch."""
    ints = np.frombuffer(col['params'][:80], dtype=np.int32)
    return int(ints[5]), int(col['init'][SLOT_FF_PTR][-1]), int(col['init'][SLOT_REC_PTR][-1])


def patch(L, state_base, blob_base):
    cols = (L['offs'] + np.uint64(state_base)).astype(np.uint64)
    ins = L['ins'].copy()
    has_v, has_g = L['voff'] >= 0, L['goff'] >= 0
    ins['vals'][has_v] = (L['voff'][has_v] + blob_base).astype(np.uint64)
    ins['gapV'][has_g] = (L['goff'][has_g] + blob_base).astype(np.uint64)
    return cols, ins


def check(L, cols, state):
    """Every member's every array against the TypeScript network's final state; returns the mismatches."""
    bad = []
    for t in range(L['n']):
        c = L['col_of'][t]
        for k, want in enumerate(cols[c]['final']):
            o = int(L['offs'][t, k])
            got = state[o:o + want.nbytes]
            if not np.array_equal(got, want.view(np.uint8)):
                bad.append((t, int(c), k))
    return bad


def source():
    src = open(os.path.join(HERE, 'column.cu')).read()
    return src.replace('#include "fdlibm.h"', open(os.path.join(HERE, 'fdlibm.h')).read()) + '\n' + open(os.path.join(HERE, 'column_par.cuh')).read()


def scratch_stride(L, threads):
    """Bytes of scratch per block (column_par.cuh parScrBytes: keep the two the same), the largest column's, 64-aligned."""
    def sz(cnt, size):
        return (cnt * size + 15) & ~15
    best = 0
    for N, nff, nrec in L['dims']:
        b = sz(N, 8) * 2 + sz(N + 1, 4) + sz(nff, 4) * 2 + sz(N + 1, 4) + sz(nrec, 4) * 2 + sz(N, 4) + sz(2 * threads, 4) + sz(N, 1)
        best = max(best, b)
    return (best + 63) // 64 * 64


NVRTC_OPTIONS = ['--fmad=false', '-prec-div=true', '-prec-sqrt=true', '-ftz=false', '-default-device']


def nvrtc_compile(arch):
    """column.cu -> (CUBIN, PTX) for sm_<arch> with PyTorch's own NVRTC library. The kernel uses no CUDA headers, so
    unlike torch.cuda._compile_kernel this needs no CUDA toolkit (CUDA_HOME) on the computer."""
    from torch.cuda._utils import _get_gpu_rtc_library
    lib = _get_gpu_rtc_library()

    def ok(res, prog=None):
        if res != 0:
            msg = ''
            if prog is not None:
                n = ctypes.c_size_t(); lib.nvrtcGetProgramLogSize(prog, ctypes.byref(n))
                buf = ctypes.create_string_buffer(n.value); lib.nvrtcGetProgramLog(prog, buf); msg = buf.value.decode(errors='replace')
            raise RuntimeError(f'NVRTC error {res}: {msg}')

    prog = ctypes.c_void_p()
    ok(lib.nvrtcCreateProgram(ctypes.byref(prog), source().encode(), b'column.cu', 0, None, None))
    opts = [f'--gpu-architecture=sm_{arch}'.encode()] + [o.encode() for o in NVRTC_OPTIONS]
    ok(lib.nvrtcCompileProgram(prog, len(opts), (ctypes.c_char_p * len(opts))(*opts)), prog)
    n = ctypes.c_size_t()
    ok(lib.nvrtcGetCUBINSize(prog, ctypes.byref(n)))
    cubin = ctypes.create_string_buffer(n.value); ok(lib.nvrtcGetCUBIN(prog, cubin))
    ptx = b''
    if hasattr(lib, 'nvrtcGetPTXSize'):
        m = ctypes.c_size_t()
        if lib.nvrtcGetPTXSize(prog, ctypes.byref(m)) == 0 and m.value:
            buf = ctypes.create_string_buffer(m.value)
            if lib.nvrtcGetPTX(prog, buf) == 0:
                ptx = buf.raw
    lib.nvrtcDestroyProgram(ctypes.byref(prog))
    return cubin.raw, ptx


class CpuBackend:
    name = 'cpu'

    def __init__(self):
        cc = os.environ.get('CC', 'cc')
        self.dir = tempfile.mkdtemp(prefix='snnk-')
        so = os.path.join(self.dir, 'snnk.so')
        subprocess.run([cc, '-O2', '-ffp-contract=off', '-fno-fast-math', '-pthread', '-shared', '-fPIC', os.path.join(HERE, 'par_cpu.c'), '-o', so, '-lm'], check=True)
        self.lib = ctypes.CDLL(so)
        self.lib.snn_columns_run_cpu.argtypes = [ctypes.c_void_p] * 5 + [ctypes.c_int] * 4
        self.lib.snn_columns_run_par_cpu.argtypes = [ctypes.c_void_p] * 5 + [ctypes.c_int] * 5

    def run(self, L, cols_bytes, members, chunk=None, threads=0):
        state = L['state'].copy()
        blob = L['blob']
        cols, ins = patch(L, state.ctypes.data, blob.ctypes.data)
        args = (L['params'].ctypes.data, L['p_idx'].ctypes.data, cols.ctypes.data, ins.ctypes.data, L['col_of'].ctypes.data, L['n'], L['C'], 0, L['rounds'])
        t0 = time.perf_counter()
        if threads:
            self.lib.snn_columns_run_par_cpu(*args, threads)
        else:
            self.lib.snn_columns_run_cpu(*args)
        return state, time.perf_counter() - t0


class GpuBackend:
    name = 'gpu'

    def __init__(self):
        import torch
        if not torch.cuda.is_available():
            raise RuntimeError('no CUDA device')
        self.torch = torch
        props = torch.cuda.get_device_properties(0)
        cubin, _ = nvrtc_compile(f'{props.major}{props.minor}')
        from torch.cuda._utils import _cuda_load_module
        mod = _cuda_load_module(cubin, ['snn_columns_run', 'snn_columns_run_par'])
        get = (lambda k: mod[k]) if isinstance(mod, dict) else (lambda k: getattr(mod, k))
        self.kernel, self.kernel_par = get('snn_columns_run'), get('snn_columns_run_par')
        self.device = torch.cuda.get_device_name(0)

    def up(self, a):
        return self.torch.from_numpy(np.ascontiguousarray(a).view(np.uint8).copy()).cuda()

    def run(self, L, cols_bytes, members, chunk=None, threads=0):
        torch = self.torch
        state = self.up(L['state'])
        blob = self.up(L['blob'])
        cols, ins = patch(L, state.data_ptr(), blob.data_ptr())
        d = {k: self.up(v) for k, v in (('params', L['params']), ('p_idx', L['p_idx']), ('cols', cols), ('ins', ins), ('col_of', L['col_of']))}
        n, R = L['n'], L['rounds']
        step = chunk or R
        if threads:
            stride = scratch_stride(L, threads)
            scratch = torch.zeros(stride * n, dtype=torch.uint8, device='cuda')
        torch.cuda.synchronize()
        t0 = time.perf_counter()
        for r0 in range(0, R, step):
            if threads:
                # One block per member x column: setup (transposed indexes) again each launch, so chunks are exact too.
                self.kernel_par(grid=(n, 1, 1), block=(threads, 1, 1), args=[d['params'], d['p_idx'], d['cols'], d['ins'], d['col_of'], scratch, stride, n, L['C'], r0, min(step, R - r0)])
            else:
                block = 64
                self.kernel(grid=((n + block - 1) // block, 1, 1), block=(block, 1, 1), args=[d['params'], d['p_idx'], d['cols'], d['ins'], d['col_of'], n, L['C'], r0, min(step, R - r0)])
        torch.cuda.synchronize()
        dt = time.perf_counter() - t0
        return state.cpu().numpy(), dt


def main(argv):
    trace = argv[0]
    cpu = '--cpu' in argv
    members = [1, 8, 32, 64, 128, 256]
    threads = 7 if cpu else 64  # the CPU twin: an odd team, so every loop's split is uneven; the GPU: 64 measured fastest
    out_json = None
    if '--members' in argv:
        members = [int(x) for x in argv[argv.index('--members') + 1].split(',')]
    if '--threads' in argv:
        threads = int(argv[argv.index('--threads') + 1])
    if '--json' in argv:
        out_json = argv[argv.index('--json') + 1]
    cols = parse_trace(trace)
    backend = CpuBackend() if cpu else GpuBackend()
    report = {'backend': backend.name, 'device': getattr(backend, 'device', 'cpu'), 'columns': len(cols), 'rounds': max(len(c['ops']) for c in cols),
              'runs': [], 'blockThreads': threads, 'blockRuns': []}
    print(f"{report['backend']} ({report['device']}): {report['columns']} column(s), {report['rounds']} recorded steps each")

    def one(m, t, kind):
        L = layout(cols, m)
        state, dt = backend.run(L, None, m, threads=t)
        bad = check(L, cols, state)
        per_round = dt / L['rounds'] * 1e6
        row = {'members': m, 'seconds': dt, 'usPerStep': per_round, 'usPerMemberColumnStep': per_round / (m * len(cols)), 'identical': not bad, 'mismatches': len(bad)}
        print(f"  {kind:6s} {m:3d} member(s): {per_round:9.1f} us per network step for all members ({row['usPerMemberColumnStep']:7.2f} us per member-column step); "
              f"{'every member bit-identical to TypeScript' if not bad else f'{len(bad)} array(s) DIFFER, first {bad[0]}'}")
        return row

    if not cpu:  # warm-up (compile, caches)
        backend.run(layout(cols, 1), None, 1)
        backend.run(layout(cols, 1), None, 1, threads=threads)
    # The thread-per-column kernel takes minutes beyond 64 members: measured up to there.
    for m in members:
        if cpu or m <= 64:
            report['runs'].append(one(m, 0, 'thread'))
    for m in members:
        report['blockRuns'].append(one(m, threads, 'block'))
    if not cpu:
        m = 64 if 64 in members else members[-1]
        report['blockSizes'] = [dict(one(m, t, f'b{t}'), threads=t) for t in (32, 128) if t != threads]
    if out_json:
        with open(out_json, 'w') as f:
            json.dump(report, f, indent=1)
    return 0 if all(r['identical'] for r in report['runs'] + report['blockRuns'] + report.get('blockSizes', [])) else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
