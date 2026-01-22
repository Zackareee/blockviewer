#!/usr/bin/env python3
"""
Bytecode Model Parser

Parses Java bytecode from Minecraft class files to extract entity model definitions.
Uses the jawa library to disassemble bytecode and extract model-building method calls
like texOffs(), addBox(), rotation(), offset().

This module provides automatic UV extraction from Minecraft's actual model definitions,
ensuring exact accuracy with the game's texture mappings.
"""

import os
from pathlib import Path
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple, Any, Union

try:
    from jawa import cf as classfile
    HAS_JAWA = True
except ImportError:
    HAS_JAWA = False


@dataclass
class ExtractedCube:
    """A cube extracted from bytecode."""
    name: str
    origin: Tuple[float, float, float]
    dimensions: Tuple[float, float, float]
    tex_offset: Tuple[int, int]
    mirror: bool = False
    grow: float = 0.0


@dataclass
class ExtractedPart:
    """A model part extracted from bytecode."""
    name: str
    cubes: List[ExtractedCube] = field(default_factory=list)
    children: Dict[str, 'ExtractedPart'] = field(default_factory=dict)
    offset: Tuple[float, float, float] = (0.0, 0.0, 0.0)
    rotation: Tuple[float, float, float] = (0.0, 0.0, 0.0)


@dataclass
class ExtractedModel:
    """A complete model extracted from bytecode."""
    name: str
    texture_width: int = 64
    texture_height: int = 64
    parts: Dict[str, ExtractedPart] = field(default_factory=dict)


class BytecodeModelParser:
    """
    Parses Java bytecode to extract entity model definitions.
    
    Uses stack-based parsing to track operands and method calls,
    extracting texOffs(), addBox(), rotation(), offset() calls.
    """
    
    def __init__(self, class_base_dir: str):
        """
        Initialize the parser.
        
        Args:
            class_base_dir: Base directory containing decompiled class files
                           (e.g., 'minecraft_versions/1.21.11_unobfuscated')
        """
        self.class_base_dir = Path(class_base_dir)
        self._class_cache: Dict[str, Any] = {}
    
    def _load_class(self, class_name: str) -> Any:
        """Load a class file by its fully qualified name."""
        if class_name in self._class_cache:
            return self._class_cache[class_name]
        
        # Convert class name to file path
        class_path = self.class_base_dir / (class_name.replace('/', os.sep) + '.class')
        
        if not class_path.exists():
            raise FileNotFoundError(f"Class file not found: {class_path}")
        
        with open(class_path, 'rb') as f:
            cf = classfile.ClassFile(f)
        
        self._class_cache[class_name] = cf
        return cf
    
    def _get_constant_value(self, cf: Any, index: int) -> Any:
        """Get the value of a constant pool entry."""
        const = cf.constants[index]
        
        # Direct value (int, float, long, double)
        if hasattr(const, 'value'):
            return const.value
        
        # String constant
        if hasattr(const, 'string') and hasattr(const.string, 'value'):
            return const.string.value
        
        return None
    
    def _get_method_name(self, cf: Any, index: int) -> Optional[str]:
        """Get the method name from a method reference constant."""
        const = cf.constants[index]
        if hasattr(const, 'name_and_type'):
            return const.name_and_type.name.value
        return None
    
    def _get_method_class(self, cf: Any, index: int) -> Optional[str]:
        """Get the class name from a method reference constant."""
        const = cf.constants[index]
        if hasattr(const, 'class_') and hasattr(const.class_, 'name'):
            return const.class_.name.value
        return None
    
    def _parse_method_bytecode(self, cf: Any, method_name: str) -> Optional[ExtractedModel]:
        """
        Parse a method's bytecode to extract model definition.
        
        Uses stack-based simulation to track operands pushed before method calls.
        The bytecode pattern for entity models is:
        
        1. ldc "part_name" -> invokestatic create -> creates CubeListBuilder
        2. iconst/bipush x, iconst/bipush y -> invokevirtual texOffs -> sets texture offset
        3. fconst/ldc x,y,z,w,h,d -> invokevirtual addBox -> adds a cube
        4. (optional) invokestatic rotation/offset -> sets part pose
        5. getstatic ZERO or invokestatic rotation -> part pose
        6. invokevirtual addOrReplaceChild -> finalizes the part
        """
        # Find the method
        method = None
        for m in cf.methods:
            if m.name.value == method_name:
                method = m
                break
        
        if method is None or method.code is None:
            return None
        
        bytecode = list(method.code.disassemble())
        
        # Stack simulation - we only track numeric and string values
        stack: List[Any] = []
        
        # Current part being built
        current_tex_offset: Tuple[int, int] = (0, 0)
        current_mirror: bool = False
        current_cubes: List[Dict[str, Any]] = []
        current_rotation: Tuple[float, float, float] = (0.0, 0.0, 0.0)
        current_offset: Tuple[float, float, float] = (0.0, 0.0, 0.0)
        
        # All parts extracted
        parts: Dict[str, ExtractedPart] = {}
        
        # Texture size (extracted from create() call at end)
        texture_width = 64
        texture_height = 64
        
        # Track the current part name
        pending_part_name: Optional[str] = None
        
        def pop_float() -> float:
            """Pop a float from the stack, converting int if needed."""
            if stack:
                v = stack.pop()
                return float(v) if isinstance(v, (int, float)) else 0.0
            return 0.0
        
        def pop_int() -> int:
            """Pop an int from the stack."""
            if stack:
                v = stack.pop()
                return int(v) if isinstance(v, (int, float)) else 0
            return 0
        
        for i, instr in enumerate(bytecode):
            mnem = instr.mnemonic
            ops = instr.operands
            
            # Push constants onto stack
            if mnem == 'iconst_0':
                stack.append(0)
            elif mnem == 'iconst_1':
                stack.append(1)
            elif mnem == 'iconst_2':
                stack.append(2)
            elif mnem == 'iconst_3':
                stack.append(3)
            elif mnem == 'iconst_4':
                stack.append(4)
            elif mnem == 'iconst_5':
                stack.append(5)
            elif mnem == 'iconst_m1':
                stack.append(-1)
            elif mnem == 'fconst_0':
                stack.append(0.0)
            elif mnem == 'fconst_1':
                stack.append(1.0)
            elif mnem == 'fconst_2':
                stack.append(2.0)
            elif mnem == 'dconst_0':
                stack.append(0.0)
            elif mnem == 'dconst_1':
                stack.append(1.0)
            elif mnem == 'bipush':
                stack.append(ops[0].value)
            elif mnem == 'sipush':
                stack.append(ops[0].value)
            elif mnem in ('ldc', 'ldc_w', 'ldc2_w'):
                val = self._get_constant_value(cf, ops[0].value)
                if val is not None:
                    stack.append(val)
            
            # Handle method calls
            elif mnem in ('invokevirtual', 'invokestatic'):
                method_ref = ops[0].value
                called_method = self._get_method_name(cf, method_ref)
                
                if called_method == 'texOffs':
                    # texOffs(int x, int y) - pops 2 ints
                    if len(stack) >= 2:
                        y = pop_int()
                        x = pop_int()
                        current_tex_offset = (x, y)
                
                elif called_method == 'addBox':
                    # addBox can have different signatures:
                    # - addBox(float x, y, z, float w, h, d) - 6 floats
                    # - addBox(String name, float x, y, z, int w, h, d, int texU, texV) - 1 string + 8 numbers
                    # - addBox(float x, y, z, float w, h, d, CubeDeformation) - 6 floats + object
                    
                    # Separate strings and numbers on stack
                    strings = [v for v in stack if isinstance(v, str)]
                    numbers = [v for v in stack if isinstance(v, (int, float))]
                    
                    if len(numbers) >= 8 and strings:
                        # Named addBox with inline tex offset:
                        # addBox(String name, float x, y, z, int w, h, d, int texU, texV)
                        tex_v = int(numbers[-1])
                        tex_u = int(numbers[-2])
                        d = float(numbers[-3])
                        h = float(numbers[-4])
                        w = float(numbers[-5])
                        z = float(numbers[-6])
                        y = float(numbers[-7])
                        x = float(numbers[-8])
                        
                        # Get the cube name - it's the last string pushed
                        cube_name = strings[-1] if strings else f"cube_{len(current_cubes)}"
                        
                        current_cubes.append({
                            'name': cube_name,
                            'origin': (x, y, z),
                            'dimensions': (w, h, d),
                            'tex_offset': (tex_u, tex_v),
                            'mirror': current_mirror,
                        })
                    elif len(numbers) >= 6:
                        # Standard addBox(x, y, z, w, h, d) - uses current_tex_offset
                        d = float(numbers[-1])
                        h = float(numbers[-2])
                        w = float(numbers[-3])
                        z = float(numbers[-4])
                        y = float(numbers[-5])
                        x = float(numbers[-6])
                        
                        cube_name = f"cube_{len(current_cubes)}"
                        
                        current_cubes.append({
                            'name': cube_name,
                            'origin': (x, y, z),
                            'dimensions': (w, h, d),
                            'tex_offset': current_tex_offset,
                            'mirror': current_mirror,
                        })
                    
                    # Clear numeric values from stack, keep strings for part name tracking
                    stack = [v for v in stack if isinstance(v, str) and v not in strings[-1:]]
                
                elif called_method == 'mirror':
                    # mirror(boolean) - sets mirror flag
                    if stack:
                        val = stack.pop()
                        current_mirror = bool(val) if isinstance(val, (int, bool)) else val == 1
                
                elif called_method == 'addOrReplaceChild':
                    # addOrReplaceChild(String name, CubeListBuilder, PartPose)
                    # At this point we should have all cubes for the current part
                    
                    part_name = pending_part_name or "unknown"
                    
                    if current_cubes:
                        part = ExtractedPart(
                            name=part_name,
                            offset=current_offset,
                            rotation=current_rotation,
                        )
                        for cube_data in current_cubes:
                            cube = ExtractedCube(
                                name=cube_data['name'],
                                origin=cube_data['origin'],
                                dimensions=cube_data['dimensions'],
                                tex_offset=cube_data['tex_offset'],
                                mirror=cube_data['mirror'],
                            )
                            part.cubes.append(cube)
                        parts[part_name] = part
                    
                    # Reset for next part
                    current_cubes = []
                    current_tex_offset = (0, 0)
                    current_mirror = False
                    current_rotation = (0.0, 0.0, 0.0)
                    current_offset = (0.0, 0.0, 0.0)
                    pending_part_name = None
                    stack.clear()
                
                elif called_method == 'rotation':
                    # PartPose.rotation(float x, float y, float z)
                    if len(stack) >= 3:
                        rz = pop_float()
                        ry = pop_float()
                        rx = pop_float()
                        current_rotation = (rx, ry, rz)
                
                elif called_method == 'offset':
                    # PartPose.offset(float x, float y, float z)
                    if len(stack) >= 3:
                        oz = pop_float()
                        oy = pop_float()
                        ox = pop_float()
                        current_offset = (ox, oy, oz)
                
                elif called_method == 'create':
                    # Could be CubeListBuilder.create() or LayerDefinition.create()
                    called_class = self._get_method_class(cf, method_ref)
                    
                    if called_class and 'LayerDefinition' in called_class:
                        # LayerDefinition.create(MeshDefinition, int w, int h)
                        # The texture size should be the last 2 ints on stack
                        numbers = [v for v in stack if isinstance(v, (int, float))]
                        if len(numbers) >= 2:
                            texture_height = int(numbers[-1])
                            texture_width = int(numbers[-2])
                        stack.clear()
                    else:
                        # CubeListBuilder.create() - the part name should be on stack
                        for v in reversed(stack):
                            if isinstance(v, str) and v not in ('texture', '#texture'):
                                pending_part_name = v
                                break
                        # Clear stack but keep tracking part name
                        stack.clear()
                
                elif called_method == 'getRoot':
                    stack.clear()
                
                elif called_method == 'getChild':
                    # getChild(String name) - used for nested parts
                    for v in reversed(stack):
                        if isinstance(v, str):
                            pending_part_name = v
                            break
                    stack.clear()
            
            # Handle getstatic (often for PartPose.ZERO)
            elif mnem == 'getstatic':
                # PartPose.ZERO means no offset/rotation
                pass
            
            # Variable operations
            elif mnem.startswith('astore') or mnem.startswith('istore') or mnem.startswith('fstore'):
                # Don't clear stack on store, just continue
                pass
            
            elif mnem == 'pop':
                if stack:
                    stack.pop()
            
            elif mnem == 'dup':
                if stack:
                    stack.append(stack[-1])
        
        # Build the final model
        model = ExtractedModel(
            name=method_name,
            texture_width=texture_width,
            texture_height=texture_height,
            parts=parts
        )
        
        return model
    
    def extract_model(self, class_name: str, method_name: str) -> Optional[ExtractedModel]:
        """
        Extract a model from a specific class and method.
        
        Args:
            class_name: Fully qualified class name (e.g., 'net/minecraft/client/renderer/blockentity/BedRenderer')
            method_name: Method name (e.g., 'createHeadLayer')
        
        Returns:
            ExtractedModel or None if extraction failed
        """
        if not HAS_JAWA:
            raise RuntimeError("jawa library not installed")
        
        try:
            cf = self._load_class(class_name)
            return self._parse_method_bytecode(cf, method_name)
        except Exception as e:
            print(f"Error extracting model from {class_name}.{method_name}: {e}")
            return None
    
    def discover_model_classes(self, search_paths: Optional[List[str]] = None) -> Dict[str, List[str]]:
        """
        Discover all classes with createXXXLayer methods returning LayerDefinition.
        
        Args:
            search_paths: List of package paths to search (relative to class_base_dir)
                         Defaults to model and renderer directories
        
        Returns:
            Dict mapping class names to lists of layer creation method names
        """
        if not HAS_JAWA:
            raise RuntimeError("jawa library not installed")
        
        if search_paths is None:
            search_paths = [
                'net/minecraft/client/model',
                'net/minecraft/client/renderer/blockentity',
            ]
        
        discovered: Dict[str, List[str]] = {}
        
        for search_path in search_paths:
            search_dir = self.class_base_dir / search_path.replace('/', os.sep)
            if not search_dir.exists():
                continue
            
            for root, dirs, files in os.walk(search_dir):
                for filename in files:
                    if not filename.endswith('.class') or '$' in filename:
                        continue
                    
                    filepath = Path(root) / filename
                    rel_path = filepath.relative_to(self.class_base_dir)
                    class_name = str(rel_path.with_suffix('')).replace(os.sep, '/')
                    
                    try:
                        cf = self._load_class(class_name)
                        layer_methods = []
                        
                        for method in cf.methods:
                            name = method.name.value
                            desc = method.descriptor.value
                            
                            if 'LayerDefinition' in desc and name.startswith('create'):
                                layer_methods.append(name)
                        
                        if layer_methods:
                            discovered[class_name] = layer_methods
                    except Exception:
                        continue
        
        return discovered


def convert_to_layer_definition(model: ExtractedModel) -> Dict[str, Any]:
    """
    Convert an ExtractedModel to the format expected by extract-block-entities.py.
    
    Returns a dict with 'texture_size', 'elements', 'metadata'.
    """
    elements = []
    
    tex_w = model.texture_width
    tex_h = model.texture_height
    
    for part_name, part in model.parts.items():
        for cube in part.cubes:
            # Apply part offset to cube origin
            ox, oy, oz = part.offset
            x1, y1, z1 = cube.origin
            x1 += ox
            y1 += oy
            z1 += oz
            
            dx, dy, dz = cube.dimensions
            x2 = x1 + dx
            y2 = y1 + dy
            z2 = z1 + dz
            
            # Calculate UVs using Minecraft's box unwrap layout
            tx, ty = cube.tex_offset
            dxi, dyi, dzi = int(dx), int(dy), int(dz)
            
            def uv(x, y, w, h):
                u1 = x / tex_w
                v1 = y / tex_h
                u2 = (x + w) / tex_w
                v2 = (y + h) / tex_h
                return [u1, v1, u2, v2]
            
            # Entity model box unwrap layout
            if cube.mirror:
                west_uv = uv(tx + dzi + dxi, ty + dzi, dzi, dyi)
                east_uv = uv(tx, ty + dzi, dzi, dyi)
            else:
                west_uv = uv(tx, ty + dzi, dzi, dyi)
                east_uv = uv(tx + dzi + dxi, ty + dzi, dzi, dyi)
            
            faces = {
                'down': uv(tx + dzi + dxi, ty, dxi, dzi),
                'up': uv(tx + dzi, ty, dxi, dzi),
                'north': uv(tx + 2 * dzi + dxi, ty + dzi, dxi, dyi),
                'south': uv(tx + dzi, ty + dzi, dxi, dyi),
                'west': west_uv,
                'east': east_uv,
            }
            
            element = {
                'from': [x1, y1, z1],
                'to': [x2, y2, z2],
                'faces': {},
                '__comment': f"{part_name}/{cube.name}",
                'shade': True,
            }
            
            for face_name, face_uv in faces.items():
                element['faces'][face_name] = {
                    'uv': face_uv,
                    'texture': '#texture',
                    'cullface': None,
                }
            
            elements.append(element)
    
    return {
        'texture_size': [tex_w, tex_h],
        'elements': elements,
        'metadata': {'normalized_uvs': True, 'shade': True, 'extracted_from_bytecode': True},
    }


# Mapping of model names to their source class/method
BYTECODE_MODEL_SOURCES = {
    # Beds - DISABLED: beds use custom UV layout that doesn't match box unwrap formula
    # Use existing JSON files instead
    # 'bed_head': {
    #     'class': 'net/minecraft/client/renderer/blockentity/BedRenderer',
    #     'method': 'createHeadLayer',
    # },
    # 'bed_foot': {
    #     'class': 'net/minecraft/client/renderer/blockentity/BedRenderer',
    #     'method': 'createFootLayer',
    # },
    
    # Signs - DISABLED: signs/hanging signs need model-space to block-space conversion
    # The model coordinates are centered at origin and need transformation
    # Use hardcoded definitions instead
    # 'sign_standing': {
    #     'class': 'net/minecraft/client/renderer/blockentity/SignRenderer',
    #     'method': 'createSignLayer',
    # },
    # 'hanging_sign': {
    #     'class': 'net/minecraft/client/renderer/blockentity/HangingSignRenderer',
    #     'method': 'createHangingSignLayer',
    # },
    
    # Chests - single chest works, double chests have JSON files
    'chest_single': {
        'class': 'net/minecraft/client/model/object/chest/ChestModel',
        'method': 'createSingleBodyLayer',
    },
    # 'chest_double_left': {
    #     'class': 'net/minecraft/client/model/object/chest/ChestModel',
    #     'method': 'createDoubleBodyLeftLayer',
    # },
    # 'chest_double_right': {
    #     'class': 'net/minecraft/client/model/object/chest/ChestModel',
    #     'method': 'createDoubleBodyRightLayer',
    # },
    
    # Skulls - DISABLED: use existing JSON files with correct UVs
    # 'skull_skeleton': {
    #     'class': 'net/minecraft/client/model/object/skull/SkullModel',
    #     'method': 'createMobHeadLayer',
    # },
    # 'skull_dragon': {
    #     'class': 'net/minecraft/client/model/object/skull/DragonHeadModel',
    #     'method': 'createHeadLayer',
    # },
    
    # Shulker - DISABLED: use existing JSON file
    # 'shulker_box': {
    #     'class': 'net/minecraft/client/model/monster/shulker/ShulkerModel',
    #     'method': 'createBoxLayer',
    # },
    
    # Bell - DISABLED: use existing JSON file
    # 'bell': {
    #     'class': 'net/minecraft/client/model/object/bell/BellModel',
    #     'method': 'createBodyLayer',
    # },
    
    # Banner - DISABLED: banners need model-space to block-space conversion
    # The model is centered at origin and extends to ~42 pixels tall
    # Use hardcoded definitions instead
    # 'banner_standing': {
    #     'class': 'net/minecraft/client/model/object/banner/BannerModel',
    #     'method': 'createBodyLayer',
    # },
    # 'banner_flag': {
    #     'class': 'net/minecraft/client/model/object/banner/BannerFlagModel',
    #     'method': 'createFlagLayer',
    # },
    
    # Book - DISABLED: model-space coordinates need transformation
    # 'book': {
    #     'class': 'net/minecraft/client/model/object/book/BookModel',
    #     'method': 'createBodyLayer',
    # },
    
    # Conduit - DISABLED: model-space coordinates centered at origin
    # 'conduit_shell': {
    #     'class': 'net/minecraft/client/renderer/blockentity/ConduitRenderer',
    #     'method': 'createShellLayer',
    # },
    # 'conduit_eye': {
    #     'class': 'net/minecraft/client/renderer/blockentity/ConduitRenderer',
    #     'method': 'createEyeLayer',
    # },
    
    # Decorated pot - DISABLED: needs coordinate transformation
    # 'decorated_pot': {
    #     'class': 'net/minecraft/client/renderer/blockentity/DecoratedPotRenderer',
    #     'method': 'createBaseLayer',
    # },
}


if __name__ == '__main__':
    import sys
    
    if len(sys.argv) < 2:
        print("Usage: python bytecode_model_parser.py <class_base_dir>")
        print("Example: python bytecode_model_parser.py minecraft_versions/1.21.11_unobfuscated")
        sys.exit(1)
    
    parser = BytecodeModelParser(sys.argv[1])
    
    print("Discovering model classes...")
    discovered = parser.discover_model_classes()
    
    print(f"\nFound {len(discovered)} classes with createXXXLayer methods:")
    for class_name, methods in sorted(discovered.items()):
        # Filter to relevant block entity models
        if any(x in class_name.lower() for x in ['bed', 'sign', 'skull', 'chest', 'shulker', 
                                                  'banner', 'bell', 'conduit', 'pot', 'book']):
            print(f"\n  {class_name}")
            for m in methods:
                print(f"    - {m}")
    
    print("\n\nExtracting bed_head model...")
    model = parser.extract_model(
        'net/minecraft/client/renderer/blockentity/BedRenderer',
        'createHeadLayer'
    )
    
    if model:
        print(f"  Texture size: {model.texture_width}x{model.texture_height}")
        print(f"  Parts: {list(model.parts.keys())}")
        for part_name, part in model.parts.items():
            print(f"    {part_name}:")
            for cube in part.cubes:
                print(f"      - {cube.name}: texOffs{cube.tex_offset}, "
                      f"addBox({cube.origin[0]}, {cube.origin[1]}, {cube.origin[2]}, "
                      f"{cube.dimensions[0]}, {cube.dimensions[1]}, {cube.dimensions[2]})")
