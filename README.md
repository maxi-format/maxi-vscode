# MAXI Format — VS Code Extension

Full language support for **MAXI** (`.maxi` / `.mxs`) files in Visual Studio Code.

[MAXI](https://github.com/maxi-format/maxi) is a compact, schema-driven serialization format designed to minimize token usage in LLM contexts and API communications while remaining human-readable.

---

## Features

### Syntax Highlighting

Every MAXI construct gets a distinct, meaningful color:

| Construct | Example |
|---|---|
| Comments | `# a comment` |
| Section separator | `###` |
| Directives | `@version:1.0.0` · `@schema:sports.mxs` |
| Type alias | `P` in `P:Player(…)` |
| Type name | `Player` |
| Inherited parents | `<Base,Mixin>` |
| Primitive types | `int` `str` `bool` `float` `decimal` `bytes` |
| Object type reference | `Team` (in a field type) |
| Enum type | `enum[forward,midfielder,defender]` |
| Map type | `map<str,int>` |
| Array suffix | `T[]` |
| Annotations | `@email` `@date` `@base64` |
| Constraints | `!` `id` `>=1` `<=50` `pattern:…` `mime:…` |
| Field default | `=unknown` |
| Record alias | `P` in `P(1|Alice|…)` |
| Quoted strings | `"hello world"` and escape sequences |
| Null | `~` |
| Inline objects | `(A1|Main St|NYC)` |
| Arrays / Maps | `[a,b,c]` · `{key:value}` |

### Semantic Highlighting

The language server enriches data records with type-aware token colors that the grammar alone cannot provide:

| Value | Field type | Color role |
|---|---|---|
| `admin` · `editor` | `enum[…]` | enum member |
| `true` · `false` · `1` · `0` | `bool` | boolean constant |
| `42` · `-17` | `int` | number |
| `3.14` · `100.00` | `decimal` / `float` | number |
| `SGVsbG8=` | `bytes` | string (muted) |
| `1` in an object-typed field | e.g. `user:U` | variable (reference) |
| `1` in the record's own id field | `int(id)` | enum member (declaration) |

### Hover Tooltips

Hover over any token to see contextual information:

- **Field value** → field name and type, e.g. `role · enum[admin, editor, user]`
- **Object reference** (bare id in an object-typed field) → the full resolved record it points to
- **Record alias** (`U` at the start of a data line) → the full resolved type definition with all fields
- **Type alias in schema** → resolved field list including inherited fields
- Annotation-aware display: `str@date` shows `date (YYYY-MM-DD)`, `str@email` shows `email address`

### Go to Definition

Press `F12` on:

- **Alias in a data record** → jumps to the type definition in the schema section
- **Parent type in `<Parent>`** → jumps to the parent's definition
- **Bare id in an object-typed field** → jumps to the referenced record
- Works across files — if the type is defined in an `@schema:` imported `.mxs` file, VS Code opens it

### Find All References

Press `Shift+F12` on any type alias to see every data record that uses it listed in the References panel.

### Rename

Press `F2` on a type alias to rename it across the entire document — the type definition line and every data record are updated atomically.

### Diagnostics

Red and yellow squiggles for schema violations:

| Code | Severity | Description |
|---|---|---|
| E003 | Error | Unknown type alias — no matching definition |
| E006 | Error / Warning | Wrong field count (too many = error, too few = warning) |
| E007 | Warning | Type mismatch (e.g. text in an `int` field) |
| E008 | Error | Invalid enum value |
| E009 | Warning | Unresolved object reference (forward refs are allowed) |
| E010 | Error | Circular inheritance |
| E011 | Error | Required field (`!`) is null or empty |
| E013 | Error | Undefined parent type |
| E016 | Error | Duplicate record identifier |
| E020 | Error | Comment in data section (not allowed after `###`) |

### Completion

`Ctrl+Space` inside a data record:

- **`enum` field** → list of valid enum values
- **`bool` field** → `1`, `0`, `true`, `false`
- **Object-typed field** → IDs of all known records of that type in the current file
- **Start of a record line** → all type aliases defined in the schema
- **`@schema:`directive** → `.mxs` files in the same directory
- **`str@date` field** → today's date in `YYYY-MM-DD`
- **`str@datetime` field** → current datetime in ISO 8601

---

## MAXI at a Glance

```maxi
@version:1.0.0

# Type alias : Type name ( field | field:type | field:type(constraints) )
U:User(
  id:int(id)         |
  name:str(!,>=1)    |
  email:str@email(!) |
  role:enum[admin,editor,viewer]=viewer |
  active:bool=1
)

O:Order(
  id:int(id)  |
  user:U      |
  total:decimal(>=0)
)

###

U(1|Alice|alice@example.com|admin|1)
U(2|Bob|bob@example.com|viewer|1)
O(100|1|149.99)
O(101|2|29.00)
```

- `U` and `O` are short **type aliases** used in data records
- Fields are **positional** — names are declared once in the schema
- `###` separates the **schema** section from the **data** section
- External schemas can be imported with `@schema:path/to/file.mxs`

---

## Installation

### From the Marketplace

Search for **MAXI Format** in the VS Code Extensions panel and click Install.

### From Source (Development)

```bash
git clone https://github.com/maxi-format/maxi-vscode
cd maxi-vscode
npm install
```

Press `F5` in VS Code to launch the Extension Development Host.

### Build a `.vsix` Package

```bash
npm install -g @vscode/vsce
vsce package
```

Then install via **Extensions: Install from VSIX…** in the VS Code command palette.

---

## File Associations

The extension activates automatically for:

| Extension | Purpose |
|---|---|
| `.maxi` | Schema + data file (has a `###` separator) |
| `.mxs` | Schema-only file (no separator, no data records) |

---

## Related

- [MAXI Specification](https://github.com/maxi-format/maxi) — the full format spec
- MAXI schema implementations see [here](https://github.com/maxi-format)

---

## License

Released under the [MIT License](./LICENSE).
