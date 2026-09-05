# SDK target reservation

This file is the owner-local cross-language reservation for **`@aimform/state`**.

CURRENT

TypeScript implementation is normalized under sdk/typescript; no Rust implementation is present.

The authored Aim contract remains `aim/package.aim`. The v3 class, Element
composition, role, provider owner, and binding owner remain in the ownership
registry until the Phase 7 physical rehome. SDK paths are reserved by contract
now; no placeholder implementation is created to fill an unsupported language.

| Target | Status | Reserved location |
| --- | --- | --- |
| TypeScript | Implemented or explicitly retained at the current source location above | `sdk/typescript/` |
| Rust | Implement only when this owner has a canonical Rust implementation | `sdk/rust/` |
| Swift | Documentation/reservation only | `sdk/swift/` |
| Kotlin | Documentation/reservation only | `sdk/kotlin/` |
| Java | Documentation/reservation only | `sdk/java/` |
| C# | Documentation/reservation only | `sdk/csharp/` |

Bindings and providers remain below the owning language SDK. A binding may
publish separately, but it cannot redefine the owner's Aim semantics.
