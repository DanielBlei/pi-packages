/**
 * Static analyzer for inline python (design D6). Pure module: `program.ts` wires it into the
 * expander, and the rules judge the effects it reports. It answers one question: which literal paths does this script read,
 * list and write, and does it use nothing outside a small allow-list?
 *
 * The script is parsed by python's own `ast` in `python3 -I -S`. The embedded analyzer only
 * parses and walks the tree; it never imports or runs the script. It does import the allowed
 * stdlib modules the script names (from a neutral cwd) to learn which module names the real
 * run could load from the run directory. Everything not on an
 * allow-list is a problem, and every failure (missing interpreter, timeout, bad output) is a
 * problem too. A caller must treat `ok: false` as "ask".
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface PythonEffects {
	/** Literal paths the script reads, exactly as the script names them. */
	reads: string[];
	/** Literal directories or glob patterns the script lists. */
	lists: string[];
	/** Absolute literal paths inside the scratch dir that the script writes. */
	writes: string[];
	/** Glob patterns the script may read: paths built from a loop variable over a listing. Omitted when empty. */
	patterns?: string[];
}

export type PythonVerdict =
	| { ok: true; effects: PythonEffects; imports: string[] }
	| { ok: false; problem: string };

export interface AnalyzeOptions {
	/** Directory the script will run in (python puts it first on sys.path). */
	runDir: string;
	/** Scratch dir. Writes are allowed only into it. */
	scratch?: string;
	env: Readonly<Record<string, string | undefined>>;
	/** Interpreter name or path. Default `python3`, resolved through `env.PATH`. */
	python?: string;
	timeoutMs?: number;
	/** Accept `while` statements (a session grant). Without it a script whose only problem is a `while` gets `whileNeedsGrant`. */
	allowWhile?: boolean;
}

const P = "python: ";

/** Every problem text. Tests assert these exactly. */
export const PYTHON_PROBLEMS = {
	pythonEnv: (key: string) => `${P}${key} in the environment changes what python loads`,
	scratchRun: (_detail = "") => `${P}the run directory is the scratch directory or inside it`,
	noInterpreter: (name: string) => `${P}no interpreter found: ${name}`,
	interpreterFailed: (detail: string) => `${P}the analyzer failed: ${detail}`,
	timeout: (_detail = "") => `${P}the analyzer timed out`,
	badOutput: (_detail = "") => `${P}the analyzer printed something unexpected`,
	analyzer: (detail: string) => `${P}analyzer error: ${detail}`,
	syntax: (detail: string) => `${P}syntax error: ${detail}`,
	tooComplex: (_detail = "") => `${P}the script is too deeply nested to check`,
	unsupportedSyntax: (node: string) => `${P}${node} syntax is not on the allow-list`,
	unknownImport: (name: string) => `${P}import ${name} is not on the allow-list`,
	starImport: (name: string) => `${P}from ${name} import * is not allowed`,
	relativeImport: (_detail = "") => `${P}relative imports are not allowed`,
	dunder: (name: string) => `${P}the name ${name} contains a double underscore`,
	forbiddenName: (name: string) => `${P}${name} can run or reach arbitrary code`,
	notAllowed: (name: string) => `${P}${name} is not on the allow-list`,
	unknownAttribute: (name: string) => `${P}${name} is not on the allow-list`,
	unknownMethod: (name: string) => `${P}the method .${name}() is not on the allow-list`,
	rebinding: (name: string) => `${P}${name} rebinds a builtin or an import`,
	moduleValue: (name: string) => `${P}the module ${name} is used as a value`,
	effectRef: (name: string) => `${P}${name} is used without being called`,
	attrStore: (name: string) => `${P}assigning to the attribute .${name} is not allowed`,
	kwSplat: (_detail = "") => `${P}** arguments are not allowed`,
	splat: (name: string) => `${P}* arguments are not allowed in ${name}`,
	decorator: (_detail = "") => `${P}decorators and type parameters are not allowed`,
	badArgs: (name: string) => `${P}the arguments of ${name} are not on the allow-list`,
	pathNotLiteral: (name: string) => `${P}the path given to ${name} is not a literal`,
	openFd: (_detail = "") => `${P}open() of something other than a literal path is not allowed`,
	openMode: (mode: string) => `${P}open() mode ${mode} is not on the allow-list`,
	writeOutsideScratch: (path: string) => `${P}writing ${path} is not inside the scratch directory`,
	writeHandle: (name: string) => `${P}${name} needs a handle opened for writing into the scratch directory`,
	recursion: (name: string) => `${P}${name} walks directories recursively`,
	withNotOpen: (_detail = "") => `${P}with accepts only open(...) here`,
	importFailed: (detail: string) => `${P}importing an allowed module failed in the analyzer: ${detail}`,
	shadow: (entry: string) => `${P}${entry} in the run directory would shadow a python module`,
	whileNeedsGrant: (_detail = "") => `${P}a \`while\` loop may not end or may fill memory, so it needs the session option`,
	matchWrite: (_detail = "") => `${P}a path derived from a listing match may not be written`,
	badPattern: (pattern: string) => `${P}the pattern ${JSON.stringify(pattern)} is not a plain glob`,
	unbounded: (what: string) => `${P}${what} can run without end or fill memory`,
	formatString: (what: string) => `${P}${what}: format strings are allowed only on a plain string literal without attribute, index or conversion fields`,
	deviceRoot: (path: string) => `${P}${path} is under /dev or /proc`,
	runDirUnreadable: (_detail = "") => `${P}the run directory cannot be read`,
};

// The analyzer is python source. It must hold no backtick and no dollar-brace.
const ANALYZER_SOURCE = String.raw`
import sys
STARTUP = set(sys.modules)
import ast, json, posixpath, importlib, string, re, fnmatch
from pathlib import PurePosixPath

class Problem(Exception):
    def __init__(self, code, detail=""):
        Exception.__init__(self, code)
        self.code = code
        self.detail = detail

def fail(code, detail=""):
    raise Problem(code, detail)

SCRATCH = sys.argv[1] if len(sys.argv) > 1 else ""
RUNDIR = sys.argv[2] if len(sys.argv) > 2 else ""
ALLOW_WHILE = len(sys.argv) > 3 and sys.argv[3] == "1"

MODULES = set("json csv re sys os os.path pathlib collections itertools functools operator statistics math datetime time string textwrap glob fnmatch difflib pprint typing dataclasses decimal fractions enum heapq bisect hashlib base64 unicodedata".split())

T = {}
def add(mod, names, kind="pure"):
    for n in names.split():
        T[mod + "." + n] = kind

add("json", "load loads dumps JSONDecodeError")
add("json", "dump", "dump")
add("csv", "reader DictReader Error")
add("csv", "writer DictWriter", "writer")
add("csv", "QUOTE_MINIMAL QUOTE_ALL QUOTE_NONNUMERIC QUOTE_NONE", "value")
add("re", "compile match search fullmatch split findall finditer sub subn escape error Pattern Match")
add("re", "IGNORECASE I MULTILINE M DOTALL S VERBOSE X ASCII A", "value")
add("sys", "stdout stderr", "stream")
add("sys", "exit")
add("os", "sep linesep", "value")
add("os", "listdir", "list")
add("os.path", "join basename dirname splitext split normpath isabs")
add("os.path", "sep", "value")
add("os.path", "exists isfile isdir getsize", "read")
add("pathlib", "Path", "path")
add("collections", "Counter defaultdict OrderedDict namedtuple deque")
add("itertools", "chain groupby islice product permutations combinations combinations_with_replacement accumulate count cycle zip_longest takewhile dropwhile starmap repeat tee compress pairwise batched filterfalse")
add("functools", "reduce partial cmp_to_key")
add("operator", "itemgetter add sub mul truediv floordiv mod neg eq ne lt le gt ge")
add("statistics", "mean fmean median median_low median_high median_grouped mode multimode stdev pstdev variance pvariance quantiles harmonic_mean geometric_mean correlation covariance StatisticsError")
add("math", "ceil floor sqrt log log2 log10 log1p exp pow fabs fsum gcd lcm isnan isinf isfinite trunc sin cos tan asin acos atan atan2 hypot degrees radians prod comb perm factorial copysign isclose dist")
add("math", "pi e inf nan tau", "value")
add("datetime", "datetime date timedelta timezone time")
add("datetime.datetime", "now utcnow today strptime fromisoformat fromtimestamp combine")
add("datetime.date", "today strptime fromisoformat fromtimestamp")
add("time", "time perf_counter")
add("string", "ascii_letters ascii_lowercase ascii_uppercase digits punctuation whitespace printable hexdigits octdigits", "value")
add("string", "capwords")
add("textwrap", "dedent fill wrap shorten indent")
add("glob", "glob iglob", "glob")
add("glob", "escape")
add("fnmatch", "fnmatch fnmatchcase filter translate")
add("difflib", "unified_diff context_diff ndiff SequenceMatcher get_close_matches")
add("pprint", "pformat")
add("pprint", "pprint", "pprint")
add("typing", "List Dict Set Tuple Optional Union Any Iterable Iterator Sequence Mapping Callable", "value")
add("decimal", "Decimal ROUND_HALF_UP ROUND_HALF_EVEN ROUND_DOWN ROUND_UP")
add("fractions", "Fraction")
add("heapq", "heappush heappop heapify heapreplace heappushpop nlargest nsmallest merge")
add("bisect", "bisect bisect_left bisect_right insort insort_left insort_right")
add("hashlib", "md5 sha1 sha224 sha256 sha384 sha512 sha3_256 blake2b blake2s new")
add("base64", "b64encode b64decode urlsafe_b64encode urlsafe_b64decode b16encode b16decode b32encode b32decode")
add("unicodedata", "normalize category name numeric")

EFFECT_KINDS = set(["read", "list", "glob", "path", "dump", "writer", "pprint"])
RECURSIVE_Q = set(["os.walk", "os.fwalk"])
UNBOUNDED_Q = set(["itertools.count", "itertools.cycle", "itertools.repeat"])
FORMAT_METHODS = set(["format", "format_map"])

BUILTINS = set("print len range enumerate zip sorted reversed sum min max abs round any all map filter isinstance int float str bool list dict set tuple frozenset repr format chr ord divmod hash iter next open bytes slice pow bin hex oct ascii Exception ValueError KeyError IndexError TypeError StopIteration FileNotFoundError ZeroDivisionError AttributeError RuntimeError UnicodeDecodeError OSError AssertionError".split())
BKIND = {"open": "open", "print": "print"}
DENIED = set("eval exec compile getattr setattr delattr globals locals vars importlib breakpoint input exit quit help".split())

READ_MODES = set(["r", "rb", "rt"])
WRITE_MODES = set(["w", "wb", "wt", "a", "x"])

DATA_ATTRS = set("name stem suffix suffixes parent parts real imag pattern string lastindex days seconds year month day hour minute second microsecond fieldnames line_num numerator denominator closed".split())
PURE_METHODS = set("""split rsplit splitlines strip lstrip rstrip join replace startswith endswith find rfind index rindex count lower upper title capitalize casefold swapcase center ljust rjust zfill isdigit isalpha isalnum isspace isupper islower isnumeric isdecimal isidentifier istitle partition rpartition encode decode format format_map expandtabs translate removeprefix removesuffix
append extend insert pop popitem sort reverse get items keys values update setdefault add discard union intersection difference symmetric_difference issubset issuperset isdisjoint copy fromkeys intersection_update difference_update
most_common elements subtract total popleft appendleft extendleft rotate
read readline readlines close flush seek tell
match search fullmatch findall finditer sub subn group groups groupdict start end span expand
hexdigest digest isoformat strftime date time timestamp total_seconds weekday isoweekday quantize bit_length is_integer as_integer_ratio""".split())
SPECIAL_ARGS = set(["replace", "copy"])
PATH_METHODS = set(["read_text", "read_bytes", "exists", "is_file", "is_dir", "iterdir", "glob"])
STREAM_WRITE = set(["write", "writelines"])
CSV_WRITE = set(["writerow", "writerows", "writeheader"])

OK_NODES = (ast.Module, ast.Expr, ast.Assign, ast.AugAssign, ast.AnnAssign, ast.For, ast.If,
    ast.Import, ast.ImportFrom, ast.Return, ast.Pass, ast.Break, ast.Continue, ast.Try, ast.Raise, ast.Assert,
    ast.With, ast.FunctionDef, ast.While,
    ast.BoolOp, ast.BinOp, ast.UnaryOp, ast.Lambda, ast.IfExp, ast.Dict, ast.Set, ast.ListComp, ast.SetComp,
    ast.DictComp, ast.GeneratorExp, ast.Compare, ast.FormattedValue, ast.JoinedStr, ast.Subscript, ast.Starred,
    ast.List, ast.Tuple, ast.Slice,
    ast.arguments, ast.arg, ast.keyword, ast.comprehension, ast.ExceptHandler, ast.withitem, ast.alias,
    ast.expr_context, ast.operator, ast.unaryop, ast.boolop, ast.cmpop)

def analyze(src):
    tree = ast.parse(src, "<script>")
    READS = []
    LISTS = []
    WRITES = []
    PATTERNS = []
    WHILE_SEEN = [False]
    PAT_OK = re.compile(r"^[A-Za-z0-9_\-./*?\[\]]+$")

    def device_path(v):
        p = v if v.startswith("/") else posixpath.join(RUNDIR, v)
        p = "/" + posixpath.normpath(p).lstrip("/")
        if p == "/dev/null":
            return False
        forms = [p]
        try:
            forms.append("/" + posixpath.realpath(p).lstrip("/"))
        except Exception:
            return True
        for f in forms:
            if f == "/dev/null":
                continue
            first = f.split("/")[1] if f.count("/") >= 1 else ""
            if fnmatch.fnmatchcase("dev", first) or fnmatch.fnmatchcase("proc", first):
                return True
        return False

    def record(lst, value):
        if device_path(value):
            fail("deviceRoot", value[:80])
        if value not in lst:
            lst.append(value)

    def dotdot(s):
        return ".." in s.split("/")
    def no_dotdot(s):
        if dotdot(s):
            fail("badPattern", s[:80])
    def record_pats(pats):
        for p in pats:
            no_dotdot(p)
            if not PAT_OK.match(p):
                fail("badPattern", p[:80])
            if device_path(p):
                fail("deviceRoot", p[:80])
            if p not in PATTERNS:
                PATTERNS.append(p)

    # identifiers: no double underscore anywhere
    for n in ast.walk(tree):
        for f in ("id", "attr", "arg", "name", "asname", "module"):
            v = getattr(n, f, None)
            if isinstance(v, str) and "__" in v:
                fail("dunder", v)
        if isinstance(n, ast.Constant) and isinstance(n.value, str) and "__" in n.value and "{" in n.value:
            fail("dunder", n.value[:40])

    # bindings
    BINDS = {}
    def bump(name):
        BINDS[name] = BINDS.get(name, 0) + 1
    for n in ast.walk(tree):
        if isinstance(n, ast.Name) and not isinstance(n.ctx, ast.Load):
            bump(n.id)
        elif isinstance(n, ast.arg):
            bump(n.arg)
        elif isinstance(n, ast.FunctionDef):
            bump(n.name)
        elif isinstance(n, ast.ExceptHandler) and n.name:
            bump(n.name)
    BOUND = set(BINDS)

    # imports
    ALIAS = {}
    ROOTS = set()
    def bind_alias(name, q):
        if name in BUILTINS or name in DENIED or name in BOUND:
            fail("rebinding", name)
        if name in ALIAS and ALIAS[name] != q:
            fail("rebinding", name)
        ALIAS[name] = q
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            for a in n.names:
                if a.name not in MODULES:
                    fail("unknownImport", a.name)
                root = a.name.split(".")[0]
                ROOTS.add(root)
                if a.asname:
                    bind_alias(a.asname, a.name)
                else:
                    bind_alias(root, root)
        elif isinstance(n, ast.ImportFrom):
            if n.level:
                fail("relativeImport")
            if not n.module or n.module not in MODULES:
                fail("unknownImport", n.module or "")
            ROOTS.add(n.module.split(".")[0])
            for a in n.names:
                if a.name == "*":
                    fail("starImport", n.module)
                q = n.module + "." + a.name
                if q in UNBOUNDED_Q:
                    fail("unbounded", q)
                if q not in T and q not in MODULES:
                    fail("unknownAttribute", q)
                bind_alias(a.asname or a.name, q)
    for name in BOUND:
        if name in BUILTINS or name in DENIED or name in ALIAS:
            fail("rebinding", name)

    def chain(node):
        attrs = []
        while isinstance(node, ast.Attribute):
            attrs.append(node.attr)
            node = node.value
        if isinstance(node, ast.Name):
            return node.id, attrs[::-1]
        return None

    def qual_of(func):
        c = chain(func)
        if not c or c[0] not in ALIAS:
            return None
        return ".".join([ALIAS[c[0]]] + c[1])

    def resolve(node):
        c = chain(node)
        if not c or c[0] not in ALIAS:
            return None
        q = ALIAS[c[0]]
        rest = c[1]
        i = 0
        while i < len(rest):
            q2 = q + "." + rest[i]
            if q2 in UNBOUNDED_Q:
                fail("unbounded", q2)
            if q2 in RECURSIVE_Q:
                fail("recursion", q2)
            if q2 in T or q2 in MODULES:
                q = q2
                i += 1
            else:
                break
        if i < len(rest) and (q in MODULES or T.get(q) not in ("value", "stream")):
            fail("unknownAttribute", q + "." + rest[i])
        return q, rest[i:]

    # constant folding: ("s", str) or ("p", str) or None
    FOLDED = {}
    def fold(n):
        if isinstance(n, ast.Constant):
            return ("s", n.value) if type(n.value) is str else None
        if isinstance(n, ast.Name):
            return FOLDED.get(n.id)
        if isinstance(n, ast.JoinedStr):
            out = ""
            for part in n.values:
                if isinstance(part, ast.Constant) and type(part.value) is str:
                    out += part.value
                elif isinstance(part, ast.FormattedValue) and part.conversion == -1 and part.format_spec is None:
                    v = fold(part.value)
                    if v is None or v[0] not in ("s", "p"):
                        return None
                    out += v[1]
                else:
                    return None
            return ("s", out)
        if isinstance(n, ast.BinOp):
            a = fold(n.left)
            b = fold(n.right)
            if a is None or b is None:
                return None
            if isinstance(n.op, ast.Add) and a[0] == "s" and b[0] == "s":
                return ("s", a[1] + b[1])
            if isinstance(n.op, ast.Add) and a[0] == "s" and b[0] == "l" and a[1] == b[1] + "/" and not dotdot(b[1]):
                return ("g", [posixpath.join(b[1], "*"), posixpath.join(b[1], ".*")])
            if isinstance(n.op, ast.Div) and a[0] == "p" and b[0] in ("s", "p"):
                return ("p", str(PurePosixPath(a[1]) / b[1]))
            if isinstance(n.op, ast.Div) and a[0] == "p" and b[0] == "l" and not dotdot(b[1]) and PurePosixPath(a[1]) == PurePosixPath(b[1]):
                return ("gp", [posixpath.join(b[1], "*"), posixpath.join(b[1], ".*")])
            return None
        if isinstance(n, ast.Call) and not n.keywords:
            q = qual_of(n.func)
            vals = [fold(a) for a in n.args]
            if any(v is None for v in vals) or any(isinstance(a, ast.Starred) for a in n.args):
                return None
            if q == "os.path.join" and vals and all(v[0] == "s" for v in vals):
                return ("s", posixpath.join(*[v[1] for v in vals]))
            if q == "os.path.join" and len(vals) == 2 and vals[0][0] == "s" and vals[1][0] == "l" and vals[0][1] == vals[1][1] and not dotdot(vals[1][1]):
                return ("g", [posixpath.join(vals[1][1], "*"), posixpath.join(vals[1][1], ".*")])
            if q == "pathlib.Path" and len(vals) == 1 and vals[0][0] == "g":
                return ("gp", vals[0][1])
            if q == "pathlib.Path" and all(v[0] in ("s", "p") for v in vals):
                return ("p", str(PurePosixPath(*[v[1] for v in vals])))
            return None
        if isinstance(n, ast.Attribute) and n.attr in ("name", "stem", "suffix", "parent"):
            base = fold(n.value)
            if base is not None and base[0] == "p":
                pp = PurePosixPath(base[1])
                if n.attr == "parent":
                    return ("p", str(pp.parent))
                return ("s", getattr(pp, n.attr))
        return None

    for stmt in tree.body:
        if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
            nm = stmt.targets[0].id
            if BINDS.get(nm) == 1:
                v = fold(stmt.value)
                if v is not None:
                    FOLDED[nm] = v

    INTS = {}
    for stmt in tree.body:
        if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
            nm = stmt.targets[0].id
            if BINDS.get(nm) == 1 and isinstance(stmt.value, ast.Constant) and type(stmt.value.value) is int:
                INTS[nm] = stmt.value.value
    def intval(n):
        if isinstance(n, ast.Constant) and type(n.value) is int:
            return n.value
        if isinstance(n, ast.Name):
            return INTS.get(n.id)
        return None
    def check_mult(a, b):
        for s in (a, b):
            v = intval(s)
            if v is not None and abs(v) > 1000000:
                fail("unbounded", "a repeat by " + str(v)[:20])
            if isinstance(s, ast.BinOp) and isinstance(s.op, (ast.Mult, ast.Pow)):
                fail("unbounded", "a nested * expression")
    def is_str_const(n):
        return isinstance(n, ast.Constant) and type(n.value) is str
    def strish(n):
        if is_str_const(n) or isinstance(n, ast.JoinedStr):
            return True
        if isinstance(n, ast.Name):
            return n.id in FOLDED and FOLDED[n.id][0] == "s"
        if isinstance(n, ast.BinOp):
            if isinstance(n.op, ast.Mod):
                return strish(n.left)
            return strish(n.left) or strish(n.right)
        return False
    def check_binop(op, left, right):
        if isinstance(op, ast.Pow):
            fail("unbounded", "**")
        if isinstance(op, ast.Mult):
            check_mult(left, right)
        elif isinstance(op, ast.Mod):
            if is_str_const(left):
                s = left.value
                if "__" in s:
                    fail("formatString", "% formatting")
                i = s.find("%(")
                while i >= 0:
                    j = s.find(")", i)
                    key = s[i + 2:j] if j >= 0 else "."
                    if "." in key or "[" in key or "(" in key:
                        fail("formatString", "% formatting")
                    i = s.find("%(", i + 2)
            elif strish(left):
                fail("formatString", "% formatting on a non-literal")
    def check_fields(s, depth=0):
        if depth > 3:
            fail("formatString", "format")
        try:
            parts = list(string.Formatter().parse(s))
        except ValueError:
            fail("formatString", "format")
        for lit, name, spec, conv in parts:
            if name is None:
                continue
            if "." in name or "[" in name or "__" in name or conv not in (None, "r", "s"):
                fail("formatString", "format")
            if spec:
                check_fields(spec, depth + 1)

    # write handles and csv writers: names bound exactly once
    def is_open_call(n):
        return isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "open"
    def open_mode(call):
        given = False
        m = None
        if len(call.args) > 1:
            m = call.args[1]
            given = True
        for k in call.keywords:
            if k.arg == "mode":
                m = k.value
                given = True
        if not given:
            return "r"
        if isinstance(m, ast.Constant) and type(m.value) is str:
            return m.value
        return None
    def is_open_write(n):
        return is_open_call(n) and open_mode(n) in WRITE_MODES
    WRITE_NAMES = set()
    CSV_WRITERS = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
            nm = n.targets[0].id
            if BINDS.get(nm) == 1:
                if is_open_write(n.value):
                    WRITE_NAMES.add(nm)
                elif isinstance(n.value, ast.Call) and qual_of(n.value.func) in ("csv.writer", "csv.DictWriter"):
                    CSV_WRITERS.add(nm)
        elif isinstance(n, ast.With):
            for it in n.items:
                if isinstance(it.optional_vars, ast.Name) and BINDS.get(it.optional_vars.id) == 1 and is_open_write(it.context_expr):
                    WRITE_NAMES.add(it.optional_vars.id)

    def is_stream(n):
        if isinstance(n, ast.Name):
            return n.id in WRITE_NAMES
        if is_open_write(n):
            return True
        return qual_of(n) in ("sys.stdout", "sys.stderr")
    def is_csv_writer(n):
        if isinstance(n, ast.Name):
            return n.id in CSV_WRITERS
        return isinstance(n, ast.Call) and qual_of(n.func) in ("csv.writer", "csv.DictWriter")

    def check_scratch(v):
        if not SCRATCH or not SCRATCH.startswith("/"):
            fail("writeOutsideScratch", v)
        if not v.startswith("/") or ".." in v.split("/"):
            fail("writeOutsideScratch", v)
        s = SCRATCH.rstrip("/")
        if not posixpath.normpath(v).startswith(s + "/"):
            fail("writeOutsideScratch", v)

    def visit_all(node):
        for a in node.args:
            visit(a)
        for k in node.keywords:
            visit(k.value)

    def do_open(node):
        if any(isinstance(a, ast.Starred) for a in node.args):
            fail("splat", "open")
        if not node.args:
            fail("pathNotLiteral", "open")
        if len(node.args) > 2:
            fail("badArgs", "open buffering")
        for k in node.keywords:
            if k.arg not in ("mode", "encoding", "errors", "newline"):
                fail("badArgs", "open " + str(k.arg))
        target = node.args[0]
        if isinstance(target, ast.Constant) and type(target.value) is not str:
            fail("openFd", "open")
        v = fold(target)
        if v is None or v[0] == "l":
            fail("pathNotLiteral", "open")
        mode = open_mode(node)
        if mode is None:
            fail("openMode", "(not a literal)")
        if v[0] in ("g", "gp"):
            if mode in READ_MODES:
                record_pats(v[1])
            elif mode in WRITE_MODES:
                fail("matchWrite", "open")
            else:
                fail("openMode", mode)
            return
        if mode in READ_MODES:
            record(READS, v[1])
        elif mode in WRITE_MODES:
            check_scratch(v[1])
            record(WRITES, v[1])
        else:
            fail("openMode", mode)

    def call_special(q, kind, node):
        args = node.args
        kws = node.keywords
        if kind == "open" or kind in EFFECT_KINDS and kind != "path":
            if any(isinstance(a, ast.Starred) for a in args):
                fail("splat", q)
        if kind == "open":
            do_open(node)
        elif kind == "print":
            for k in kws:
                if k.arg not in ("sep", "end", "file", "flush"):
                    fail("badArgs", "print " + str(k.arg))
                if k.arg == "file" and not is_stream(k.value):
                    fail("writeHandle", "print file=")
        elif kind == "read":
            if len(args) != 1 or kws:
                fail("badArgs", q)
            v = fold(args[0])
            if v is None or v[0] == "l":
                fail("pathNotLiteral", q)
            if v[0] in ("g", "gp"):
                record_pats(v[1])
            else:
                record(READS, v[1])
        elif kind == "list":
            if kws or len(args) > 1:
                fail("badArgs", q)
            if not args:
                record(LISTS, ".")
            else:
                v = fold(args[0])
                if v is None or v[0] not in ("s", "p"):
                    fail("pathNotLiteral", q)
                no_dotdot(v[1])
                record(LISTS, v[1])
        elif kind == "glob":
            for k in kws:
                if k.arg != "recursive":
                    fail("badArgs", q + " " + str(k.arg))
                if not (isinstance(k.value, ast.Constant) and k.value.value is False):
                    fail("recursion", q + " recursive")
            if len(args) != 1:
                fail("badArgs", q)
            v = fold(args[0])
            if v is None or v[0] != "s":
                fail("pathNotLiteral", q)
            if "**" in v[1]:
                fail("recursion", v[1])
            no_dotdot(v[1])
            record(LISTS, v[1])
        elif kind == "dump":
            target = args[1] if len(args) > 1 else None
            for k in kws:
                if k.arg == "fp":
                    target = k.value
            if len(args) > 2 or target is None or not is_stream(target):
                fail("writeHandle", q)
        elif kind == "writer":
            if not args or not is_stream(args[0]):
                fail("writeHandle", q)
        elif kind == "pprint":
            if len(args) != 1:
                fail("badArgs", q)
            for k in kws:
                if k.arg not in ("indent", "width", "depth", "compact", "sort_dicts", "underscore_numbers"):
                    fail("badArgs", q + " " + str(k.arg))
        visit_all(node)

    def method_call(recv, attr, node):
        args = node.args
        kws = node.keywords
        if attr == "format_map":
            fail("formatString", "format_map")
        elif attr == "format":
            if not is_str_const(recv):
                fail("formatString", "format on a non-literal")
            check_fields(recv.value)
        elif attr in STREAM_WRITE:
            if not is_stream(recv):
                fail("writeHandle", attr)
        elif attr in CSV_WRITE:
            if not is_csv_writer(recv):
                fail("writeHandle", attr)
        elif attr in ("rglob", "walk"):
            fail("recursion", attr)
        elif attr in PATH_METHODS:
            if any(isinstance(a, ast.Starred) for a in args):
                fail("splat", attr)
            v = fold(recv)
            if v is not None and v[0] == "gp" and attr in ("read_text", "read_bytes", "exists", "is_file", "is_dir"):
                if attr in ("read_text", "read_bytes"):
                    if len(args) > 2:
                        fail("badArgs", attr)
                    for k in kws:
                        if k.arg not in ("encoding", "errors"):
                            fail("badArgs", attr + " " + str(k.arg))
                elif args or kws:
                    fail("badArgs", attr)
                record_pats(v[1])
                visit(recv)
                visit_all(node)
                return
            if v is None or v[0] != "p":
                fail("pathNotLiteral", attr)
            if attr == "glob":
                if len(args) != 1 or kws:
                    fail("badArgs", attr)
                pv = fold(args[0])
                if pv is None or pv[0] != "s":
                    fail("pathNotLiteral", attr)
                if "**" in pv[1]:
                    fail("recursion", pv[1])
                no_dotdot(v[1])
                no_dotdot(pv[1])
                record(LISTS, posixpath.join(v[1], pv[1]))
            elif attr == "iterdir":
                if args or kws:
                    fail("badArgs", attr)
                no_dotdot(v[1])
                record(LISTS, v[1])
            elif attr in ("read_text", "read_bytes"):
                if len(args) > 2:
                    fail("badArgs", attr)
                for k in kws:
                    if k.arg not in ("encoding", "errors"):
                        fail("badArgs", attr + " " + str(k.arg))
                record(READS, v[1])
            else:
                if args or kws:
                    fail("badArgs", attr)
                record(READS, v[1])
        elif attr == "replace":
            if len(args) < 2:
                fail("unknownMethod", attr)
        elif attr == "copy":
            if args or kws:
                fail("unknownMethod", attr)
        elif attr not in PURE_METHODS:
            fail("unknownMethod", attr)
        visit(recv)
        visit_all(node)

    def visit_call(node):
        for k in node.keywords:
            if k.arg is None:
                fail("kwSplat")
        func = node.func
        if isinstance(func, ast.Name):
            i = func.id
            if i in ALIAS:
                q = ALIAS[i]
                if q in MODULES:
                    fail("moduleValue", i)
                call_special(q, T.get(q, "pure"), node)
            elif i in BOUND:
                visit_all(node)
            elif i in BUILTINS:
                if i == "pow":
                    fail("unbounded", "pow")
                if i == "format":
                    if node.keywords or len(node.args) > 2 or any(isinstance(a, ast.Starred) for a in node.args):
                        fail("formatString", "format()")
                    if len(node.args) == 2 and not is_str_const(node.args[1]):
                        fail("formatString", "format() with a spec that is not a literal")
                    if len(node.args) == 2:
                        check_fields(node.args[1].value)
                call_special(i, BKIND.get(i, "pure"), node)
            elif i in DENIED:
                fail("forbiddenName", i)
            else:
                fail("notAllowed", i)
        elif isinstance(func, ast.Attribute):
            r = resolve(func)
            if r is not None and not r[1]:
                if r[0] in MODULES:
                    fail("moduleValue", r[0])
                call_special(r[0], T.get(r[0], "pure"), node)
            else:
                method_call(func.value, func.attr, node)
        else:
            visit(func)
            visit_all(node)

    def visit_name(node):
        if not isinstance(node.ctx, ast.Load):
            return
        i = node.id
        if i in ALIAS:
            q = ALIAS[i]
            if q in MODULES:
                fail("moduleValue", i)
            if T.get(q) in EFFECT_KINDS:
                fail("effectRef", q)
        elif i in BOUND:
            return
        elif i in BUILTINS:
            if i == "open":
                fail("effectRef", i)
            if i in ("format", "pow"):
                fail("formatString" if i == "format" else "unbounded", i + " used as a value")
        elif i in DENIED:
            fail("forbiddenName", i)
        else:
            fail("notAllowed", i)

    def visit_attribute(node):
        if not isinstance(node.ctx, ast.Load):
            fail("attrStore", node.attr)
        r = resolve(node)
        if r is not None:
            q, rest = r
            if not rest:
                if q in MODULES:
                    fail("moduleValue", q)
                if T.get(q) in EFFECT_KINDS:
                    fail("effectRef", q)
                return
            for a in rest:
                if a in FORMAT_METHODS:
                    fail("formatString", "." + a + " used as a value")
                if a not in DATA_ATTRS and (a not in PURE_METHODS or a in SPECIAL_ARGS):
                    fail("unknownAttribute", q + "." + a)
            return
        a = node.attr
        if a in FORMAT_METHODS:
            fail("formatString", "." + a + " used as a value")
        if a in DATA_ATTRS or (a in PURE_METHODS and a not in SPECIAL_ARGS):
            visit(node.value)
            return
        fail("unknownAttribute", a)

    # literal-list and listing loops: the loop variable folds once per value, or stands for "a match"
    ITER_NAMES = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.For):
            it = n.iter
            if isinstance(it, ast.Call) and isinstance(it.func, ast.Name) and it.func.id == "sorted" and len(it.args) == 1 and not it.keywords:
                it = it.args[0]
            if isinstance(it, ast.Name):
                ITER_NAMES.add(id(it))
    def str_items(it):
        if isinstance(it, (ast.List, ast.Tuple)) and 1 <= len(it.elts) <= 16 and all(is_str_const(e) for e in it.elts):
            return [e.value for e in it.elts]
        return None
    LITLISTS = {}
    for stmt in tree.body:
        if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name) and BINDS.get(stmt.targets[0].id) == 1:
            items = str_items(stmt.value)
            if items is not None:
                LITLISTS[stmt.targets[0].id] = items
    for n in ast.walk(tree):
        if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load) and n.id in LITLISTS and id(n) not in ITER_NAMES:
            LITLISTS.pop(n.id, None)
    def unsorted_iter(it):
        if isinstance(it, ast.Call) and isinstance(it.func, ast.Name) and it.func.id == "sorted" and len(it.args) == 1 and not it.keywords:
            return it.args[0]
        return it
    def lit_items(it):
        it = unsorted_iter(it)
        if isinstance(it, ast.Name):
            return LITLISTS.get(it.id)
        return str_items(it)
    def path_glob_patterns(d, g):
        no_dotdot(d)
        no_dotdot(g)
        parts = g.split("/")
        for c in parts:
            if c[:1] in ("?", "[") or "[" in c:
                fail("badPattern", g[:80])
        idx = [i for i, c in enumerate(parts) if c and c[0] in "*?["]
        if len(idx) > 3:
            fail("badPattern", g[:80])
        pats = []
        for mask in range(1 << len(idx)):
            ps = list(parts)
            for bit, i in enumerate(idx):
                if mask >> bit & 1:
                    ps[i] = "." + ps[i]
            pats.append(posixpath.join(d, "/".join(ps)))
        return pats
    def listing_source(it):
        it = unsorted_iter(it)
        if not isinstance(it, ast.Call) or it.keywords or any(isinstance(a, ast.Starred) for a in it.args):
            return None
        q = qual_of(it.func)
        if q in ("glob.glob", "glob.iglob") and len(it.args) == 1:
            v = fold(it.args[0])
            if v is not None and v[0] == "s" and "**" not in v[1]:
                no_dotdot(v[1])
                return ("g", [v[1]])
            return None
        if q == "os.listdir" and len(it.args) == 1:
            v = fold(it.args[0])
            if v is not None and v[0] == "s":
                no_dotdot(v[1])
                return ("l", v[1])
            return None
        if isinstance(it.func, ast.Attribute):
            base = fold(it.func.value)
            if base is not None and base[0] == "p":
                if it.func.attr == "glob" and len(it.args) == 1:
                    g = fold(it.args[0])
                    if g is not None and g[0] == "s" and "**" not in g[1]:
                        return ("gp", path_glob_patterns(base[1], g[1]))
                elif it.func.attr == "iterdir" and not it.args:
                    no_dotdot(base[1])
                    return ("gp", [posixpath.join(base[1], "*"), posixpath.join(base[1], ".*")])
        return None
    COMBOS = [1]
    DERIVED = []
    def try_for(node):
        if not isinstance(node.target, ast.Name) or BINDS.get(node.target.id) != 1:
            return False
        nm = node.target.id
        items = lit_items(node.iter)
        if items is not None:
            values = [("s", x) for x in dict.fromkeys(items)]
            if COMBOS[0] * len(values) > 64:
                return False
        else:
            src = listing_source(node.iter)
            if src is None:
                return False
            values = [src]
        visit(node.iter)
        COMBOS[0] *= len(values)
        for val in values:
            FOLDED[nm] = val
            DERIVED.append([])
            for c in node.body:
                visit(c)
            for d in DERIVED.pop():
                FOLDED.pop(d, None)
        FOLDED.pop(nm, None)
        COMBOS[0] //= len(values)
        for c in node.orelse:
            visit(c)
        return True

    def visit(node):
        if isinstance(node, ast.For) and try_for(node):
            return
        if isinstance(node, ast.Call):
            return visit_call(node)
        if isinstance(node, ast.Attribute):
            return visit_attribute(node)
        if isinstance(node, ast.Name):
            return visit_name(node)
        if isinstance(node, ast.Constant):
            if type(node.value) is int and abs(node.value) > 10000000:
                fail("unbounded", "the number " + str(node.value)[:20])
            return
        if isinstance(node, ast.While) and not ALLOW_WHILE:
            WHILE_SEEN[0] = True
        if not isinstance(node, OK_NODES):
            fail("unsupportedSyntax", type(node).__name__)
        if isinstance(node, ast.BinOp):
            check_binop(node.op, node.left, node.right)
        elif isinstance(node, ast.AugAssign):
            check_binop(node.op, node.target, node.value)
        elif isinstance(node, ast.FormattedValue):
            if node.format_spec is not None and any(isinstance(x, ast.FormattedValue) for x in ast.walk(node.format_spec)):
                fail("formatString", "an f-string with a computed format spec")
        if isinstance(node, ast.With):
            for it in node.items:
                if not is_open_call(it.context_expr):
                    fail("withNotOpen")
                if it.optional_vars is not None and not isinstance(it.optional_vars, ast.Name):
                    fail("withNotOpen")
        elif isinstance(node, ast.FunctionDef):
            if node.decorator_list or getattr(node, "type_params", None):
                fail("decorator")
        for c in ast.iter_child_nodes(node):
            visit(c)
        if DERIVED and isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            nm = node.targets[0].id
            if BINDS.get(nm) == 1 and nm not in FOLDED:
                v = fold(node.value)
                if v is not None:
                    FOLDED[nm] = v
                    DERIVED[-1].append(nm)

    visit(tree)

    # Top-level names the real run could import from sys.path[0]: the startup set, site and its
    # customize hooks (the real run does not use -S), and everything the allowed imports load.
    CLOSURE = set(STARTUP)
    CLOSURE.update(["site", "sitecustomize", "usercustomize"])
    try:
        importlib.import_module("site")
        for root in sorted(ROOTS):
            importlib.import_module(root)
    except BaseException as e:
        fail("importFailed", type(e).__name__)
    for name in list(sys.modules):
        CLOSURE.add(name.split(".")[0])
    return {"ok": True, "closure": sorted(CLOSURE), "reads": READS, "lists": LISTS, "writes": WRITES, "patterns": PATTERNS, "whileSeen": WHILE_SEEN[0], "imports": sorted(ROOTS)}

def main():
    src = sys.stdin.buffer.read()
    try:
        out = analyze(src)
    except Problem as p:
        out = {"ok": False, "code": p.code, "detail": p.detail}
    except SyntaxError as e:
        out = {"ok": False, "code": "syntax", "detail": "%s (line %s)" % (e.msg, e.lineno)}
    except (ValueError, MemoryError) as e:
        out = {"ok": False, "code": "syntax", "detail": str(e)[:100]}
    except RecursionError:
        out = {"ok": False, "code": "tooComplex", "detail": ""}
    except BaseException as e:
        out = {"ok": False, "code": "analyzer", "detail": type(e).__name__}
    sys.stdout.write(json.dumps(out))

main()
`;

interface RawOk {
	ok: true;
	reads: string[];
	lists: string[];
	writes: string[];
	patterns: string[];
	whileSeen: boolean;
	imports: string[];
	closure: string[];
}
type Raw = RawOk | { ok: false; problem: string };

const cache = new Map<string, Raw>();
const CACHE_LIMIT = 256;

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function problemFromCode(code: string, detail: string): string {
	const fn = (PYTHON_PROBLEMS as Record<string, ((d: string) => string) | undefined>)[code];
	return fn ? fn(detail) : PYTHON_PROBLEMS.analyzer(`${code} ${detail}`);
}

function isExecutable(file: string): boolean {
	try {
		if (!statSync(file).isFile()) return false;
		accessSync(file, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function resolveInterpreter(name: string, pathEnv: string, runDir: string): string | undefined {
	if (name.includes("/")) {
		const file = resolve(runDir, name);
		return isExecutable(file) ? file : undefined;
	}
	for (const dir of pathEnv.split(":")) {
		if (!dir) continue;
		const file = join(resolve(runDir, dir), name);
		if (isExecutable(file)) return file;
	}
	return undefined;
}

function realOr(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
}

function inside(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function runAnalyzer(script: string, interpreter: string, scratch: string, runDir: string, pathEnv: string, timeoutMs: number, allowWhile: boolean): Raw {
	// Neutral, empty cwd: the analyzer imports allowed modules and must never see the run dir.
	let neutral: string;
	try {
		neutral = mkdtempSync(join(tmpdir(), "pi-keeper-pyan-"));
	} catch (e) {
		return { ok: false, problem: PYTHON_PROBLEMS.interpreterFailed((e as Error).message.slice(0, 200)) };
	}
	let result;
	try {
		result = spawnSync(interpreter, ["-I", "-S", "-c", ANALYZER_SOURCE, scratch, runDir, allowWhile ? "1" : "0"], {
			input: script,
			timeout: timeoutMs,
			env: { PATH: pathEnv, LC_ALL: "C" },
			cwd: neutral,
			stdio: ["pipe", "pipe", "pipe"],
			encoding: "utf8",
			maxBuffer: 4 * 1024 * 1024,
		});
	} finally {
		try {
			rmSync(neutral, { recursive: true, force: true });
		} catch {
			// best effort
		}
	}
	if (result.error) {
		const code = (result.error as NodeJS.ErrnoException).code;
		if (code === "ETIMEDOUT") return { ok: false, problem: PYTHON_PROBLEMS.timeout() };
		if (code === "ENOENT" || code === "EACCES") return { ok: false, problem: PYTHON_PROBLEMS.noInterpreter(interpreter) };
		return { ok: false, problem: PYTHON_PROBLEMS.interpreterFailed(result.error.message) };
	}
	if (result.status !== 0) {
		const detail = (result.stderr || `exit ${result.status ?? result.signal}`).trim().split("\n").pop() ?? "";
		return { ok: false, problem: PYTHON_PROBLEMS.interpreterFailed(detail.slice(0, 200)) };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		return { ok: false, problem: PYTHON_PROBLEMS.badOutput() };
	}
	if (typeof parsed !== "object" || parsed === null) return { ok: false, problem: PYTHON_PROBLEMS.badOutput() };
	const o = parsed as Record<string, unknown>;
	if (o.ok === false && typeof o.code === "string") {
		return { ok: false, problem: problemFromCode(o.code, typeof o.detail === "string" ? o.detail : "") };
	}
	if (
		o.ok === true &&
		isStringArray(o.reads) &&
		isStringArray(o.lists) &&
		isStringArray(o.writes) &&
		isStringArray(o.patterns) &&
		typeof o.whileSeen === "boolean" &&
		isStringArray(o.imports) &&
		isStringArray(o.closure)
	) {
		return { ok: true, reads: o.reads, lists: o.lists, writes: o.writes, patterns: o.patterns, whileSeen: o.whileSeen, imports: o.imports, closure: o.closure };
	}
	return { ok: false, problem: PYTHON_PROBLEMS.badOutput() };
}

/** Names python would import from the run directory before the real module. */
function shadowProblem(runDir: string, names: ReadonlySet<string>): string | undefined {
	let entries;
	try {
		entries = readdirSync(runDir, { withFileTypes: true });
	} catch {
		return PYTHON_PROBLEMS.runDirUnreadable();
	}
	for (const entry of entries) {
		const n = entry.name;
		if (n === "__pycache__") continue;
		const dot = n.indexOf(".");
		const base = dot < 0 ? n : n.slice(0, dot);
		if (!names.has(base)) continue;
		const ext = dot < 0 ? "" : n.slice(dot);
		const isModuleFile = ext === ".py" || ext === ".pyc" || ext === ".pyw" || ext.endsWith(".so") || ext.endsWith(".pyd");
		if (isModuleFile || (dot < 0 && !entry.isFile())) return PYTHON_PROBLEMS.shadow(n);
	}
	return undefined;
}

export function analyzePythonScript(script: string, options: AnalyzeOptions): PythonVerdict {
	for (const key of Object.keys(options.env)) {
		if (key.startsWith("PYTHON")) return { ok: false, problem: PYTHON_PROBLEMS.pythonEnv(key) };
	}
	const runDir = resolve(options.runDir);
	const scratch = options.scratch ? resolve(options.scratch) : "";
	if (scratch && (inside(runDir, scratch) || inside(realOr(runDir), realOr(scratch)))) {
		return { ok: false, problem: PYTHON_PROBLEMS.scratchRun() };
	}
	const pathEnv = options.env.PATH ?? "";
	const wanted = options.python ?? "python3";
	const interpreter = resolveInterpreter(wanted, pathEnv, runDir);
	if (!interpreter) return { ok: false, problem: PYTHON_PROBLEMS.noInterpreter(wanted) };

	const allowWhile = options.allowWhile === true;
	const key = [createHash("sha256").update(script).digest("hex"), interpreter, scratch, runDir, allowWhile ? "while" : ""].join("\0");
	let raw = cache.get(key);
	if (!raw) {
		raw = runAnalyzer(script, interpreter, scratch, runDir, pathEnv, options.timeoutMs ?? 2000, allowWhile);
		if (cache.size >= CACHE_LIMIT) cache.clear();
		cache.set(key, raw);
	}
	if (!raw.ok) return { ok: false, problem: raw.problem };

	// The directory can change between calls, so the shadow check is never cached.
	const names = new Set<string>(raw.closure);
	const shadow = shadowProblem(runDir, names);
	if (shadow) return { ok: false, problem: shadow };
	if (raw.whileSeen) return { ok: false, problem: PYTHON_PROBLEMS.whileNeedsGrant() };
	const effects: PythonEffects = { reads: [...raw.reads], lists: [...raw.lists], writes: [...raw.writes] };
	if (raw.patterns.length > 0) effects.patterns = [...raw.patterns];
	return { ok: true, effects, imports: [...raw.imports] };
}
