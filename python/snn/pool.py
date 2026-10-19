"""Device pool for SNN columns: the GPU tournament engine's device side (research/snnGpu.ts).

Holds the columns of a group of tournament members and steps them in lockstep, one round per network step: the host
sends one record per column (its inputs and cross-column terms) and gets back each column's summary (group.cuh), so the
network-level logic stays in the TypeScript. Bit for bit the TypeScript network's.

    python pool.py           the GPU (PyTorch's CUDA, the kernel compiled by its NVRTC: no CUDA toolkit needed)
    python pool.py --cpu [--threads N]   the same C on the CPU (the tests; CC = the C compiler): serial, or with N
                                         threads the GPU's group kernel on POSIX threads (group_cpu.c)

Protocol (stdin -> stdout, little-endian): request frames [u32 length][u8 op][payload], reply frames [u32 length][payload].
    1 ADD    i32 ni, ints, i32 nd, doubles (SnnP), u32 na, na x [u32 dtype][u32 n][bytes]  ->  i32 column id
    2 STEP   u32 n, n x 64-byte GRec, u32 nv, nv doubles (the records' vals)               ->  n x GSUM doubles, then the
             features (nE + nL1 + nL0 doubles) of each record that asked for them, in record order
    3 GET    i32 id                                                                         ->  the column's arrays as in ADD
    4 FREE   i32 id                                                                         ->  (empty)
    5 INFO                                                                                  ->  JSON: backend, device, threads
    9 QUIT
dtype: 0 float64, 1 float32, 2 int32, 3 uint8.
"""

import ctypes
import json
import os
import struct
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
N_SLOTS = 80
GSUM = 34
REC = 64
ES = [8, 4, 4, 1]
SLOT_FF_PTR, SLOT_REC_PTR = 68, 70


def source():
    src = open(os.path.join(HERE, 'column.cu')).read().replace('#include "fdlibm.h"', open(os.path.join(HERE, 'fdlibm.h')).read())
    return src + '\n' + open(os.path.join(HERE, 'column_par.cuh')).read() + '\n' + open(os.path.join(HERE, 'group.cuh')).read()


def scr_bytes(N, nff, nrec, T):
    """column_par.cuh parScrBytes (keep the two the same)."""
    def sz(cnt, size):
        return (cnt * size + 15) & ~15
    return sz(N, 8) * 2 + sz(N + 1, 4) + sz(nff, 4) * 2 + sz(N + 1, 4) + sz(nrec, 4) * 2 + sz(N, 4) + sz(2 * T, 4) + sz(N, 1)


class Column:
    """A column's params (SnnP bytes), its arrays' layout (dtype, n, offset in one blob) and dims."""

    def __init__(self, params, arrays):
        self.params = params
        self.dtypes = [a[0] for a in arrays]
        self.lens = [a[1] for a in arrays]
        self.offs, pos = [], 0
        for dt, n, _ in arrays:
            self.offs.append(pos)
            pos += (n * ES[dt] + 7) // 8 * 8
        self.size = max(pos, 8)
        blob = bytearray(self.size)
        for (dt, n, b), o in zip(arrays, self.offs):
            blob[o:o + len(b)] = b
        self.blob = blob
        ints = struct.unpack_from('<20i', params, 0)
        self.nL0, self.nL1, self.nE, self.N = ints[0], ints[1], ints[4], ints[5]
        self.nff = struct.unpack_from('<i', arrays[SLOT_FF_PTR][2], 4 * self.nL1)[0]
        self.nrec = struct.unpack_from('<i', arrays[SLOT_REC_PTR][2], 4 * self.N)[0]
        self.nfeat = self.nE + self.nL1 + self.nL0

    def arrays_from(self, blob):
        return [(dt, n, bytes(blob[o:o + n * ES[dt]])) for dt, n, o in zip(self.dtypes, self.lens, self.offs)]


class CpuPool:
    """The C build (group_cpu.c) through a shared library: serial (column.cu colStep), or with threads the GPU's group
    kernel on POSIX threads. The tests' parity reference."""
    name = 'cpu'

    def __init__(self, threads=0):
        cc = os.environ.get('CC', 'cc')
        d = tempfile.mkdtemp(prefix='snnpool-')
        so = os.path.join(d, 'pool.so')
        subprocess.run([cc, '-O2', '-ffp-contract=off', '-fno-fast-math', '-pthread', '-shared', '-fPIC', os.path.join(HERE, 'group_cpu.c'), '-o', so, '-lm'], check=True)
        self.lib = ctypes.CDLL(so)
        self.lib.snn_group_step_cpu.argtypes = [ctypes.c_void_p] * 6 + [ctypes.c_int, ctypes.c_int]
        self.lib.snn_group_step_par_cpu.argtypes = [ctypes.c_void_p] * 8 + [ctypes.c_int] * 3
        self.cols, self.bufs, self.scrs, self.psize = {}, {}, {}, None
        self.params = self.slots = self.scrptrs = self.built = None
        self.cap = 0
        self.device = 'cpu'
        self.threads = threads

    def _grow(self, need):
        if need <= self.cap:
            return
        cap = max(16, need * 2)
        params = ctypes.create_string_buffer(cap * self.psize)
        slots = (ctypes.c_void_p * (cap * N_SLOTS))()
        scrptrs = (ctypes.c_void_p * cap)()
        built = (ctypes.c_int * cap)()
        if self.params is not None:
            ctypes.memmove(params, self.params, self.cap * self.psize)
            ctypes.memmove(slots, self.slots, self.cap * N_SLOTS * 8)
            ctypes.memmove(scrptrs, self.scrptrs, self.cap * 8)
            ctypes.memmove(built, self.built, self.cap * 4)
        self.params, self.slots, self.scrptrs, self.built, self.cap = params, slots, scrptrs, built, cap

    def add(self, cid, col):
        self.psize = self.psize or len(col.params)
        self._grow(cid + 1)
        buf = ctypes.create_string_buffer(bytes(col.blob), col.size)
        self.cols[cid], self.bufs[cid] = col, buf
        ctypes.memmove(ctypes.addressof(self.params) + cid * self.psize, col.params, self.psize)
        base = ctypes.addressof(buf)
        for k, o in enumerate(col.offs):
            self.slots[cid * N_SLOTS + k] = base + o
        if self.threads:
            scr = ctypes.create_string_buffer(scr_bytes(col.N, col.nff, col.nrec, self.threads) + 64)
            self.scrs[cid] = scr
            self.scrptrs[cid] = ctypes.addressof(scr)
            self.built[cid] = 0

    def step(self, n, recs, vals, stride, feat_wanted=True):
        sums = ctypes.create_string_buffer(max(1, n * GSUM * 8))
        feat = ctypes.create_string_buffer(max(1, n * stride * 8))
        r = ctypes.create_string_buffer(recs, max(1, len(recs)))
        v = ctypes.create_string_buffer(vals, max(8, len(vals)))
        if self.threads:
            self.lib.snn_group_step_par_cpu(ctypes.addressof(self.params), ctypes.addressof(self.slots), ctypes.addressof(self.scrptrs), ctypes.addressof(self.built),
                                            r, v, sums, feat, stride, n, self.threads)
        else:
            self.lib.snn_group_step_cpu(ctypes.addressof(self.params), ctypes.addressof(self.slots), r, v, sums, feat, stride, n)
        return sums.raw[:n * GSUM * 8], feat.raw[:n * stride * 8]

    def get(self, cid):
        return self.cols[cid].arrays_from(self.bufs[cid].raw)

    def free(self, cid):
        self.cols.pop(cid, None)
        self.bufs.pop(cid, None)
        self.scrs.pop(cid, None)


class GpuPool:
    """The block kernel (column_par.cuh via group.cuh snn_group_step) on the GPU, one thread block per column."""
    name = 'gpu'

    def __init__(self, threads=64):
        import torch
        if not torch.cuda.is_available():
            raise RuntimeError('no CUDA device')
        sys.path.insert(0, HERE)
        from bench import nvrtc_compile_source
        from torch.cuda._utils import _cuda_load_module
        self.torch = torch
        props = torch.cuda.get_device_properties(0)
        cubin, _ = nvrtc_compile_source(source(), f'{props.major}{props.minor}')
        mod = _cuda_load_module(cubin, ['snn_group_step'])
        self.kernel = mod['snn_group_step'] if isinstance(mod, dict) else getattr(mod, 'snn_group_step')
        self.device = torch.cuda.get_device_name(0)
        self.threads = threads
        self.cols, self.mem, self.scr = {}, {}, {}
        self.psize = None
        self.cap = 0
        self.d_params = self.d_slots = self.d_scr = self.d_built = None
        self.h_params = self.h_slots = self.h_scr = None

    def _upload_tables(self):
        t = self.torch
        self.d_params = t.frombuffer(bytearray(self.h_params), dtype=t.uint8).cuda()
        self.d_slots = t.frombuffer(bytearray(self.h_slots), dtype=t.uint8).cuda()
        self.d_scr = t.frombuffer(bytearray(self.h_scr), dtype=t.uint8).cuda()

    def add(self, cid, col):
        t = self.torch
        self.psize = self.psize or len(col.params)
        if cid >= self.cap:
            cap = max(16, (cid + 1) * 2)
            hp, hs, hc = bytearray(cap * self.psize), bytearray(cap * N_SLOTS * 8), bytearray(cap * 8)
            built = t.zeros(cap, dtype=t.int32, device='cuda')
            if self.h_params is not None:
                hp[:len(self.h_params)] = self.h_params
                hs[:len(self.h_slots)] = self.h_slots
                hc[:len(self.h_scr)] = self.h_scr
                built[:self.cap] = self.d_built
            self.h_params, self.h_slots, self.h_scr, self.d_built, self.cap = hp, hs, hc, built, cap
        mem = t.frombuffer(bytearray(col.blob), dtype=t.uint8).cuda()
        scr = t.zeros(scr_bytes(col.N, col.nff, col.nrec, self.threads) + 64, dtype=t.uint8, device='cuda')
        self.cols[cid], self.mem[cid], self.scr[cid] = col, mem, scr
        self.h_params[cid * self.psize:(cid + 1) * self.psize] = col.params
        base = mem.data_ptr()
        struct.pack_into('<%dQ' % N_SLOTS, self.h_slots, cid * N_SLOTS * 8, *[base + o for o in col.offs])
        struct.pack_into('<Q', self.h_scr, cid * 8, scr.data_ptr())
        self.d_built[cid] = 0
        self._upload_tables()

    def _buf(self, name, n, dtype):
        b = getattr(self, name, None)
        if b is None or b.numel() < n:
            b = self.torch.empty(max(1, n * 2), dtype=dtype, device='cuda')
            setattr(self, name, b)
        return b

    def step(self, n, recs, vals, stride, feat_wanted=True):
        t = self.torch
        d_recs = self._buf('_recs', len(recs), t.uint8)
        d_recs[:len(recs)].copy_(t.frombuffer(bytearray(recs), dtype=t.uint8))
        v = vals or b'\0' * 8
        d_vals = self._buf('_vals', len(v), t.uint8)
        d_vals[:len(v)].copy_(t.frombuffer(bytearray(v), dtype=t.uint8))
        sums = self._buf('_sums', n * GSUM, t.float64)
        feat = self._buf('_feat', n * stride, t.float64)
        self.kernel(grid=(n, 1, 1), block=(self.threads, 1, 1),
                    args=[self.d_params, self.d_slots, self.d_scr, self.d_built, d_recs, d_vals, sums, feat, stride, n])
        return host_bytes(sums, n * GSUM * 8), host_bytes(feat, n * stride * 8) if feat_wanted else b''

    def get(self, cid):
        return self.cols[cid].arrays_from(host_bytes(self.mem[cid], self.cols[cid].size))

    def free(self, cid):
        self.cols.pop(cid, None)
        self.mem.pop(cid, None)
        self.scr.pop(cid, None)


def host_bytes(tensor, nbytes):
    """A device tensor's first nbytes as bytes (no numpy)."""
    c = tensor.reshape(-1)[:max(1, nbytes // tensor.element_size())].cpu()
    buf = ctypes.create_string_buffer(max(1, nbytes))
    if nbytes:
        ctypes.memmove(buf, c.data_ptr(), nbytes)
    return buf.raw[:nbytes]


def read_exact(f, n):
    out = bytearray()
    while len(out) < n:
        b = f.read(n - len(out))
        if not b:
            raise EOFError
        out += b
    return bytes(out)


def parse_arrays(p, i):
    na = struct.unpack_from('<I', p, i)[0]; i += 4
    arrays = []
    for _ in range(na):
        dt, n = struct.unpack_from('<II', p, i); i += 8
        arrays.append((dt, n, p[i:i + n * ES[dt]])); i += n * ES[dt]
    return arrays, i


def pack_arrays(arrays):
    out = [struct.pack('<I', len(arrays))]
    for dt, n, b in arrays:
        out.append(struct.pack('<II', dt, n))
        out.append(b)
    return b''.join(out)


def main(argv):
    threads = int(argv[argv.index('--threads') + 1]) if '--threads' in argv else 0
    pool = CpuPool(threads) if '--cpu' in argv else GpuPool(threads or int(os.environ.get('SNN_GPU_THREADS', '64')))
    fin, fout = sys.stdin.buffer, sys.stdout.buffer
    next_id, stride = 0, 1

    def reply(b):
        fout.write(struct.pack('<I', len(b)))
        fout.write(b)
        fout.flush()

    while True:
        try:
            head = read_exact(fin, 5)
        except EOFError:
            return 0
        length, op = struct.unpack('<IB', head)
        p = read_exact(fin, length)
        if op == 1:
            ni = struct.unpack_from('<i', p, 0)[0]; i = 4
            ints = p[i:i + 4 * ni]; i += 4 * ni
            nd = struct.unpack_from('<i', p, i)[0]; i += 4
            dbls = p[i:i + 8 * nd]; i += 8 * nd
            arrays, i = parse_arrays(p, i)
            if len(arrays) != N_SLOTS:
                raise ValueError(f'column has {len(arrays)} arrays, the kernel {N_SLOTS}')
            cid = next_id; next_id += 1
            col = Column(ints + dbls, arrays)
            pool.add(cid, col)
            stride = max(stride, col.nfeat)
            reply(struct.pack('<i', cid))
        elif op == 2:
            n = struct.unpack_from('<I', p, 0)[0]
            recs = p[4:4 + n * REC]
            i = 4 + n * REC
            nv = struct.unpack_from('<I', p, i)[0]; i += 4
            vals = p[i:i + 8 * nv]
            stride = max(stride, 1)
            wants = [struct.unpack_from('<i', recs, k * REC + 16)[0] for k in range(n)]
            sums, feat = pool.step(n, recs, vals, stride, any(w & 2 for w in wants))
            out = [sums]
            for k in range(n):
                cid = struct.unpack_from('<i', recs, k * REC)[0]
                if wants[k] & 2:
                    nf = pool.cols[cid].nfeat
                    out.append(feat[k * stride * 8:(k * stride + nf) * 8])
            reply(b''.join(out))
        elif op == 3:
            cid = struct.unpack_from('<i', p, 0)[0]
            reply(pack_arrays(pool.get(cid)))
        elif op == 4:
            pool.free(struct.unpack_from('<i', p, 0)[0])
            reply(b'')
        elif op == 5:
            reply(json.dumps({'backend': pool.name, 'device': pool.device, 'threads': pool.threads}).encode())
        elif op == 9:
            reply(b'')
            return 0
        else:
            raise ValueError(f'unknown op {op}')


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
