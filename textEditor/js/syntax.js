const EXTENSIONS = {
  c: "c", h: "c", cc: "cpp", cp: "cpp", cpp: "cpp", cxx: "cpp",
  hpp: "cpp", hxx: "cpp", js: "javascript", mjs: "javascript",
  css: "css", html: "html", htm: "html", json: "json",
  py: "python", rs: "rust", java: "java", sh: "shell",
  bash: "shell", mk: "makefile", cmake: "cmake", kconfig: "kconfig",
  kbuild: "kconfig", txt: "plaintext", md: "markdown",
  dts: "devicetree", dtsi: "devicetree", dtso: "devicetree"
};

export function languageFromFilename(name) {
  const lower = name.toLowerCase();
  const base = lower.split("/").pop();
  if (base === "makefile") return "makefile";
  if (base === "kconfig" || base.startsWith("kconfig.")) return "kconfig";
  const match = lower.match(/\.([^.]+)$/);
  return match ? (EXTENSIONS[match[1]] || "plaintext") : "plaintext";
}

export function languageLabel(lang) {
  const labels = {
    c: "C", cpp: "C++", javascript: "JavaScript", css: "CSS", html: "HTML",
    json: "JSON", python: "Python", rust: "Rust", java: "Java", shell: "Shell",
    makefile: "Makefile", cmake: "CMake", kconfig: "Kconfig",
    markdown: "Markdown", plaintext: "Plain Text", devicetree: "DeviceTree"
  };
  return labels[lang] || "Plain Text";
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function tokeniseCode(code, language) {
  // Small dependency-free lexer. It intentionally favors robust display over
  // attempting to be a complete compiler parser.
  const patterns = [];

  // C/C++ preprocessor directives are checked before comments. This keeps
  // #include/#define/#ifdef etc. correct even when they immediately follow
  // a // comment line.
  if (["c", "cpp", "java", "rust"].includes(language)) {
    patterns.push(["preproc", /^[ \t]*#[ \t]*[A-Za-z_]\w*/ym]);
  }

  // Devicetree source files may pull in C-preprocessor directives (typically
  // via #include from a .dtsi), but also use "#foo-cells"-style property
  // names that must NOT be mistaken for a directive — so only a known,
  // fixed set of directive keywords is matched here.
  if (language === "devicetree") {
    patterns.push(["preproc", /^[ \t]*#[ \t]*(?:include|define|undef|ifdef|ifndef|elif|else|endif|pragma|error|warning|line)\b/ym]);
    patterns.push(["preproc", /\/(?:dts-v1|plugin|memreserve|include|delete-node|delete-property|omit-if-no-ref)\//y]);
    patterns.push(["type", /&[A-Za-z_][\w-]*/y]);
  }

  if (["c", "cpp", "javascript", "java", "rust", "css", "kconfig", "shell", "cmake", "makefile", "devicetree"].includes(language)) {
    patterns.push(["comment", /\/\/[^\n]*|\/\*[\s\S]*?\*\//y]);
  }

  patterns.push(["string", /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/y]);

  const keywords = {
    c: "auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while _Bool _Complex _Imaginary",
    cpp: "alignas alignof asm auto bool break case catch class const constexpr consteval constinit const_cast continue co_await co_return co_yield decltype default delete do dynamic_cast else enum explicit export extern false final for friend goto if inline mutable namespace new noexcept nullptr operator private protected public register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while",
    javascript: "as async await break case catch class const const continue debugger default delete do else export extends false finally for from function get if import in instanceof let new null of return set static super switch this throw true try typeof undefined var void while with yield",
    java: "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try true false void volatile while",
    rust: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
    python: "and as assert async await break case class continue def del elif else except False finally for from global if import in is lambda match None nonlocal not or pass raise return True try while with yield",
    shell: "if then else elif fi for while in do done case esac function select time until",
    kconfig: "menuconfig config menu endmenu choice endchoice if endif source osource rsource mainmenu comment help depends on select imply default def_bool def_tristate bool tristate string int hex range prompt visible if",
    devicetree: "compatible reg status interrupts interrupt-parent interrupt-controller interrupt-cells interrupt-map interrupt-map-mask clocks clock-names clock-output-names clock-frequency clock-cells ranges dma-ranges dmas dma-names reg-names phandle label device_type model bootargs stdout-path chosen aliases memory cpus cpu gpio-controller gpio-cells gpios address-cells size-cells pinctrl-names pinctrl-0 pinctrl-1 pinctrl-2 assigned-clocks assigned-clock-parents assigned-clock-rates power-domains power-domain-cells resets reset-names reset-cells vendor endianness cell-index max-speed current-speed baud regulator-name regulator-min-microvolt regulator-max-microvolt regulator-boot-on regulator-always-on target target-path",
  };
  const kw = keywords[language];
  if (kw) patterns.push(["keyword", new RegExp("\\b(?:" + kw.split(" ").join("|") + ")\\b", "y")]);

  if (["c", "cpp", "java", "rust"].includes(language)) {
    patterns.push(["type", /\b(?:char|double|float|int|long|short|signed|unsigned|size_t|uint8_t|uint16_t|uint32_t|uint64_t|int8_t|int16_t|int32_t|int64_t|FILE|bool|string|String)\b/y]);
  }

  patterns.push(["number", /\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?)\b/y]);

  let out = "";
  let i = 0;
  let lineStart = true;

  while (i < code.length) {
    let matched = false;

    for (const [type, re] of patterns) {
      re.lastIndex = i;
      const m = re.exec(code);
      if (!m) continue;

      // Preprocessor expressions are anchored to the beginning of a line.
      out += `<span class="syntax-${type}">${escapeHtml(m[0])}</span>`;
      i = re.lastIndex;
      const lastNewline = m[0].lastIndexOf("\n");
      lineStart = lastNewline >= 0
        ? lastNewline === m[0].length - 1
        : false;
      matched = true;
      break;
    }

    if (matched) continue;

    const ch = code[i];
    out += escapeHtml(ch);
    if (ch === "\n") lineStart = true;
    else if (ch !== "\r") lineStart = false;
    i++;
  }

  // Highlight common function names after tokenisation without disturbing tags.
  if (["c", "cpp", "java", "rust", "javascript"].includes(language)) {
    out = out.replace(/(<span[^>]*>.*?<\/span>)|(\b[A-Za-z_]\w*)(?=\s*\()/g,
      (all, token) => token ? all : `<span class="syntax-function">${all}</span>`);
  }

  return out;
}

export function highlight(code, language) {
  if (language === "plaintext") return escapeHtml(code);
  if (language === "json") {
    return tokeniseCode(code, "javascript");
  }
  return tokeniseCode(code, language);
}
