#!/usr/bin/env python3
"""
Minecraft Particle Decompiler
Extracts particle parameters from .class files and translates them to Block Viewer's system.

Usage:
    python3 scripts/decompile_particle.py <class_file_or_particle_name>

Examples:
    python3 scripts/decompile_particle.py SporeBlossomAirProvider
    python3 scripts/decompile_particle.py minecraft_versions/.../DripParticle.class
    python3 scripts/decompile_particle.py flame
"""

import struct
import sys
import os
from pathlib import Path

# ============================================================================
# CONVERSION CONSTANTS
# Minecraft runs at 20 ticks/second
# ============================================================================
MC_TICKS_PER_SECOND = 20

def mc_ticks_to_seconds(ticks):
    """Convert MC ticks to seconds"""
    return ticks / MC_TICKS_PER_SECOND

def mc_velocity_to_bv(mc_vel):
    """
    Convert MC velocity (blocks/tick) to Block Viewer velocity (blocks/second)
    MC applies velocity per tick, BV applies per second
    """
    return mc_vel * MC_TICKS_PER_SECOND

def mc_gravity_to_bv(mc_gravity):
    """
    Convert MC gravity to Block Viewer gravity.
    MC: velocity -= gravity per tick
    BV: velocity -= gravity * ticksElapsed * 0.05
    
    To match: mc_gravity = bv_gravity * 0.05
    So: bv_gravity = mc_gravity / 0.05 = mc_gravity * 20
    """
    return mc_gravity * 20

def mc_friction_to_bv(mc_friction):
    """
    MC friction is applied per tick: v *= friction
    BV applies: v *= friction^ticksElapsed (where ticksElapsed = deltaTime * 20)
    
    Since BV already handles this correctly, we can use MC friction directly.
    """
    return mc_friction

# ============================================================================
# CLASS FILE PARSER
# ============================================================================

CONSTANT_TAGS = {
    1: 'Utf8',
    3: 'Integer',
    4: 'Float',
    5: 'Long',
    6: 'Double',
    7: 'Class',
    8: 'String',
    9: 'Fieldref',
    10: 'Methodref',
    11: 'InterfaceMethodref',
    12: 'NameAndType',
    15: 'MethodHandle',
    16: 'MethodType',
    17: 'Dynamic',
    18: 'InvokeDynamic',
    19: 'Module',
    20: 'Package',
}

def parse_class_file(filepath):
    """Parse a Java .class file and extract constant pool entries"""
    with open(filepath, 'rb') as f:
        data = f.read()
    
    # Verify magic number
    magic = struct.unpack('>I', data[0:4])[0]
    if magic != 0xCAFEBABE:
        raise ValueError(f"Not a valid Java class file: {filepath}")
    
    # Skip version info
    idx = 8
    
    # Parse constant pool count
    cp_count = struct.unpack('>H', data[idx:idx+2])[0]
    idx += 2
    
    constants = {0: None}  # Index 0 is unused
    i = 1
    
    while i < cp_count:
        if idx >= len(data):
            break
            
        tag = data[idx]
        idx += 1
        
        if tag == 1:  # Utf8
            length = struct.unpack('>H', data[idx:idx+2])[0]
            idx += 2
            value = data[idx:idx+length].decode('utf-8', errors='replace')
            idx += length
            constants[i] = ('Utf8', value)
            
        elif tag == 3:  # Integer
            value = struct.unpack('>i', data[idx:idx+4])[0]
            idx += 4
            constants[i] = ('Integer', value)
            
        elif tag == 4:  # Float
            value = struct.unpack('>f', data[idx:idx+4])[0]
            idx += 4
            constants[i] = ('Float', value)
            
        elif tag == 5:  # Long
            value = struct.unpack('>q', data[idx:idx+8])[0]
            idx += 8
            constants[i] = ('Long', value)
            i += 1  # Long takes 2 slots
            
        elif tag == 6:  # Double
            value = struct.unpack('>d', data[idx:idx+8])[0]
            idx += 8
            constants[i] = ('Double', value)
            i += 1  # Double takes 2 slots
            
        elif tag == 7:  # Class
            idx += 2
            constants[i] = ('Class', None)
            
        elif tag == 8:  # String
            idx += 2
            constants[i] = ('String', None)
            
        elif tag in [9, 10, 11, 12]:  # Fieldref, Methodref, InterfaceMethodref, NameAndType
            idx += 4
            constants[i] = (CONSTANT_TAGS.get(tag, 'Unknown'), None)
            
        elif tag == 15:  # MethodHandle
            idx += 3
            constants[i] = ('MethodHandle', None)
            
        elif tag == 16:  # MethodType
            idx += 2
            constants[i] = ('MethodType', None)
            
        elif tag in [17, 18]:  # Dynamic, InvokeDynamic
            idx += 4
            constants[i] = (CONSTANT_TAGS.get(tag, 'Unknown'), None)
            
        elif tag in [19, 20]:  # Module, Package
            idx += 2
            constants[i] = (CONSTANT_TAGS.get(tag, 'Unknown'), None)
            
        else:
            print(f"Warning: Unknown constant tag {tag} at index {i}")
            break
            
        i += 1
    
    return constants

def analyze_particle_class(filepath):
    """Analyze a particle class file and extract relevant parameters"""
    constants = parse_class_file(filepath)
    
    # Categorize values
    floats = []
    doubles = []
    integers = []
    strings = []
    
    for idx, entry in constants.items():
        if entry is None:
            continue
        tag, value = entry
        if tag == 'Float':
            floats.append((idx, value))
        elif tag == 'Double':
            doubles.append((idx, value))
        elif tag == 'Integer':
            integers.append((idx, value))
        elif tag == 'Utf8':
            strings.append((idx, value))
    
    return {
        'floats': floats,
        'doubles': doubles,
        'integers': integers,
        'strings': strings,
    }

def identify_particle_params(analysis):
    """Try to identify what each numeric constant likely represents"""
    params = {
        'color_r': None,
        'color_g': None,
        'color_b': None,
        'velocity': [],
        'gravity': None,
        'friction': None,
        'lifetime': None,
        'size': None,
        'spawn_chance': None,
    }
    
    # Look for RGB color patterns (3 consecutive floats 0-1)
    all_nums = sorted(analysis['floats'] + analysis['doubles'], key=lambda x: x[0])
    
    # Extract relevant strings for context
    relevant_strings = []
    for idx, s in analysis['strings']:
        s_lower = s.lower()
        if any(kw in s_lower for kw in ['color', 'gravity', 'friction', 'velocity', 
                                          'speed', 'lifetime', 'age', 'scale', 'size',
                                          'alpha', 'red', 'green', 'blue', 'rate']):
            relevant_strings.append((idx, s))
    
    return params, relevant_strings

def print_analysis(filepath, analysis):
    """Print a formatted analysis of the particle class"""
    filename = os.path.basename(filepath)
    
    print("=" * 80)
    print(f"MINECRAFT PARTICLE ANALYSIS: {filename}")
    print("=" * 80)
    print()
    
    # Print numeric constants
    print("FLOAT CONSTANTS:")
    print("-" * 40)
    for idx, value in sorted(analysis['floats'], key=lambda x: x[0]):
        # Try to guess what this value might be
        hint = ""
        if 0.0 <= value <= 1.0:
            hint = "  (possibly: color, alpha, friction, spawn_chance)"
        elif 0.01 <= value <= 0.1:
            hint = "  (possibly: velocity, gravity, size)"
        elif 1.0 < value <= 5.0:
            hint = "  (possibly: size_scale, speed_mult)"
        elif value > 10:
            hint = "  (possibly: lifetime_ticks)"
        print(f"  [{idx:3d}] {value:12.6f}{hint}")
    print()
    
    print("DOUBLE CONSTANTS:")
    print("-" * 40)
    for idx, value in sorted(analysis['doubles'], key=lambda x: x[0]):
        hint = ""
        if -1.0 <= value <= 1.0:
            hint = "  (possibly: velocity, offset, color)"
        elif abs(value) > 10:
            hint = "  (possibly: range, lifetime)"
        print(f"  [{idx:3d}] {value:12.6f}{hint}")
    print()
    
    print("INTEGER CONSTANTS:")
    print("-" * 40)
    for idx, value in sorted(analysis['integers'], key=lambda x: x[0]):
        hint = ""
        if 1 <= value <= 200:
            hint = f"  (possibly: lifetime_ticks = {mc_ticks_to_seconds(value):.2f}s)"
        print(f"  [{idx:3d}] {value:8d}{hint}")
    print()
    
    # Print relevant strings
    print("RELEVANT STRINGS (keywords):")
    print("-" * 40)
    keywords = ['color', 'gravity', 'friction', 'velocity', 'speed', 'lifetime', 
                'age', 'scale', 'size', 'alpha', 'red', 'green', 'blue', 'rate',
                'particle', 'provider', 'spawn']
    for idx, s in analysis['strings']:
        if any(kw in s.lower() for kw in keywords):
            print(f"  [{idx:3d}] {s}")
    print()

def print_conversion_guide():
    """Print the conversion guide between MC and Block Viewer"""
    print()
    print("=" * 80)
    print("MINECRAFT → BLOCK VIEWER CONVERSION GUIDE")
    print("=" * 80)
    print("""
VELOCITY:
  MC: blocks per tick
  BV: blocks per second
  Formula: bv_velocity = mc_velocity * 20
  Example: MC 0.05 → BV 1.0 blocks/sec

LIFETIME:
  MC: ticks (20 ticks = 1 second)
  BV: seconds
  Formula: bv_lifetime = mc_lifetime / 20
  Example: MC 64 ticks → BV 3.2 seconds

GRAVITY:
  MC: velocity change per tick (subtracted from vy)
  BV: gravity value (applied as: vy -= gravity * ticksElapsed * 0.05)
  Formula: bv_gravity = mc_gravity * 20
  Example: MC 0.04 → BV 0.8

FRICTION:
  MC: velocity multiplier per tick (e.g., 0.98)
  BV: same value (applied as: v *= friction^ticksElapsed)
  Formula: bv_friction = mc_friction (no conversion needed)
  Example: MC 0.98 → BV 0.98

COLOR:
  MC: RGB floats 0.0-1.0
  BV: RGB floats 0.0-1.0 (direct copy)
  Example: MC [0.32, 0.50, 0.22] → BV [0.32, 0.50, 0.22]

SIZE:
  MC: scale factor (typically 0.1-3.0)
  BV: world units (blocks)
  Note: MC base particle is ~0.1 blocks, so:
  Formula: bv_size = mc_scale * 0.1
  Example: MC scale 1.0 → BV 0.1 blocks

SPAWN RATE:
  MC: often a probability per animateTick (called ~randomly for visible blocks)
  BV: particles per second
  Formula: bv_rate ≈ mc_chance * 4 (rough approximation)
  Example: MC 0.3 (30% per animateTick) → BV ~1.2/sec
""")

def find_class_file(name):
    """Find a class file by name in particle OR block directories"""
    search_dirs = [
        Path("minecraft_versions/1.21.11_unobfuscated/net/minecraft/client/particle"),
        Path("minecraft_versions/1.21.11_unobfuscated/net/minecraft/world/level/block"),
    ]
    
    all_matches = []
    
    for base_dir in search_dirs:
        if not base_dir.exists():
            continue
        
        # Try exact match first
        exact = base_dir / f"{name}.class"
        if exact.exists():
            return str(exact)
        
        # Try with Provider suffix (for particle classes)
        provider = base_dir / f"{name}Provider.class"
        if provider.exists():
            return str(provider)
        
        # Try with Block suffix (for block classes)
        block = base_dir / f"{name}Block.class"
        if block.exists():
            return str(block)
        
        # Try with Particle suffix
        particle = base_dir / f"{name}Particle.class"
        if particle.exists():
            return str(particle)
        
        # Search for partial matches
        matches = list(base_dir.glob(f"*{name}*.class"))
        all_matches.extend(matches)
    
    if all_matches:
        print(f"Found {len(all_matches)} matching files:")
        for m in sorted(all_matches, key=lambda x: x.name)[:15]:
            print(f"  {m.parent.name}/{m.name}")
        if len(all_matches) > 15:
            print(f"  ... and {len(all_matches) - 15} more")
        print()
        return str(all_matches[0])
    
    return None


def find_related_classes(name):
    """Find all related classes (particle + block + providers) for a given name"""
    search_dirs = [
        Path("minecraft_versions/1.21.11_unobfuscated/net/minecraft/client/particle"),
        Path("minecraft_versions/1.21.11_unobfuscated/net/minecraft/world/level/block"),
    ]
    
    related = []
    search_terms = [name]
    
    # Add common variations
    if 'Block' not in name and 'Particle' not in name:
        search_terms.extend([f"{name}Block", f"{name}Particle"])
    
    for base_dir in search_dirs:
        if not base_dir.exists():
            continue
        
        for term in search_terms:
            # Find all classes containing this term
            matches = list(base_dir.glob(f"*{term}*.class"))
            related.extend(matches)
    
    # Remove duplicates and sort
    unique = list(set(related))
    return sorted(unique, key=lambda x: x.name)

def analyze_all_related(name):
    """Analyze all related classes for a given name"""
    related = find_related_classes(name)
    
    if not related:
        print(f"No related classes found for '{name}'")
        return
    
    print("=" * 80)
    print(f"ANALYZING ALL RELATED CLASSES FOR: {name}")
    print("=" * 80)
    print(f"Found {len(related)} related class files\n")
    
    for filepath in related:
        try:
            analysis = analyze_particle_class(str(filepath))
            
            # Skip if no numeric constants
            if not analysis['floats'] and not analysis['doubles'] and not analysis['integers']:
                continue
            
            print(f"--- {filepath.parent.name}/{filepath.name} ---")
            
            if analysis['floats']:
                print("  Floats:")
                for idx, value in sorted(analysis['floats'], key=lambda x: x[0]):
                    print(f"    [{idx:3d}] {value:.6f}")
            
            if analysis['doubles']:
                print("  Doubles:")
                for idx, value in sorted(analysis['doubles'], key=lambda x: x[0]):
                    print(f"    [{idx:3d}] {value:.6f}")
            
            if analysis['integers']:
                useful_ints = [(i, v) for i, v in analysis['integers'] if 0 <= v < 1000]
                if useful_ints:
                    print("  Integers (0-999):")
                    for idx, value in sorted(useful_ints, key=lambda x: x[0]):
                        print(f"    [{idx:3d}] {value}")
            
            print()
            
        except Exception as e:
            print(f"  Error: {e}")
            print()


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        print("\nSearches both particle AND block class directories.")
        print("\nAvailable particle classes:")
        base_dir = Path("minecraft_versions/1.21.11_unobfuscated/net/minecraft/client/particle")
        if base_dir.exists():
            classes = sorted([f.name for f in base_dir.glob("*.class") if 'Provider' in f.name or 'Particle' in f.name])
            for c in classes[:20]:
                print(f"  {c}")
            if len(classes) > 20:
                print(f"  ... and {len(classes) - 20} more")
        
        print("\nExample block classes with particles:")
        block_dir = Path("minecraft_versions/1.21.11_unobfuscated/net/minecraft/world/level/block")
        if block_dir.exists():
            # Show some common particle-emitting blocks
            particle_blocks = ['Torch', 'Campfire', 'Candle', 'Spore', 'Firefly', 'Leaves', 'Lava', 'Fire']
            for term in particle_blocks:
                matches = list(block_dir.glob(f"*{term}*.class"))
                if matches:
                    print(f"  {matches[0].name}")
        return
    
    target = sys.argv[1]
    
    # Check for --all flag to analyze all related classes
    analyze_related = '--all' in sys.argv or '-a' in sys.argv
    
    if analyze_related:
        # Remove flags from target if present
        target = [arg for arg in sys.argv[1:] if not arg.startswith('-')][0]
        analyze_all_related(target)
        print_conversion_guide()
        return
    
    # Check if it's a file path or a name
    if os.path.exists(target):
        filepath = target
    else:
        filepath = find_class_file(target)
        if not filepath:
            print(f"Error: Could not find class for '{target}'")
            print(f"Try: python3 {sys.argv[0]} {target} --all")
            return
    
    print(f"\nAnalyzing: {filepath}\n")
    
    try:
        analysis = analyze_particle_class(filepath)
        print_analysis(filepath, analysis)
        print_conversion_guide()
        
        # Print Block Viewer config template
        print()
        print("=" * 80)
        print("BLOCK VIEWER CONFIG TEMPLATE")
        print("=" * 80)
        print("""
// TODO: Fill in values from analysis above
{
  type: 'particle_name',
  rate: 2.0,                    // Spawn rate (particles/sec)
  offset: [0.5, 0.5, 0.5],      // Spawn position in block
  offsetVariance: [0.1, 0.0, 0.1],
  velocity: [0, -0.5, 0],       // Initial velocity (blocks/sec)
  velocityVariance: [0.02, 0.05, 0.02],
  size: 0.1,                    // Particle size (blocks)
  sizeVariance: 0.02,
  lifetime: 3.0,                // Lifetime (seconds)
  lifetimeVariance: 0.5,
  color: [1.0, 1.0, 1.0],       // RGB tint
  alpha: 0.9,
  fadeIn: 0.1,
  fadeOut: 0.3,
  friction: 0.98,               // Velocity decay per tick
  gravity: 0.0,                 // Downward acceleration
  hasPhysics: true,             // Collide with blocks?
}
""")
        
        # Suggest related classes
        print()
        print("=" * 80)
        print("RELATED CLASSES (use --all to analyze all)")
        print("=" * 80)
        # Extract base name for searching
        base_name = os.path.basename(filepath).replace('.class', '')
        # Remove common suffixes/prefixes for better matching
        for suffix in ['Block', 'Particle', 'Provider', '$']:
            idx = base_name.find(suffix)
            if idx > 0:
                base_name = base_name[:idx]
                break
        
        related = find_related_classes(base_name)
        if related:
            for r in related[:10]:
                print(f"  {r.parent.name}/{r.name}")
            if len(related) > 10:
                print(f"  ... and {len(related) - 10} more")
        
    except Exception as e:
        print(f"Error analyzing class file: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    main()

