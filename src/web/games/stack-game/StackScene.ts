import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  Fog,
  GridHelper,
  HemisphereLight,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  RingGeometry,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import {
  STACK_GAME_BLOCK_HISTORY_LIMIT,
  STACK_GAME_MIN_SIZE,
} from "../../../games/stack-game/engine";

export interface StackBlockVisual {
  readonly id: string;
  readonly level: number;
  readonly x: number;
  readonly z: number;
  readonly width: number;
  readonly depth: number;
}

export interface StackFragmentVisual extends StackBlockVisual {
  readonly axis: "x" | "z";
  readonly side: "negative" | "positive";
}

const BLOCK_HEIGHT = 0.42;
const MAX_FALLING_FRAGMENTS = 28;
const MAX_CELEBRATIONS = 10;
const FALLING_GRAVITY = 7.2;
const PALETTE = [
  0x32c6bd,
  0xf27a6d,
  0xf2c45e,
  0x5d9df5,
  0xe58bc5,
  0x9bd765,
] as const;

interface BlockRecord {
  visual: StackBlockVisual;
  mesh: Mesh;
  width: number;
  depth: number;
  restY: number;
  dropOffset: number;
  active: boolean;
}

interface FallingFragment {
  mesh: Mesh;
  velocity: Vector3;
  spin: Vector3;
  life: number;
  maxLife: number;
}

interface Celebration {
  ring: Mesh;
  particles: Points;
  positions: Float32Array;
  velocities: Float32Array;
  count: number;
  life: number;
  maxLife: number;
}

function finiteValue(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function levelValue(level: number): number {
  return Math.max(0, finiteValue(level, 0));
}

function coordinateValue(value: number): number {
  return finiteValue(value, 0);
}

function dimensionValue(value: number): number {
  return Math.min(8, Math.max(STACK_GAME_MIN_SIZE, finiteValue(value, 1)));
}

function materialList(material: Material | Material[]): readonly Material[] {
  return Array.isArray(material) ? material : [material];
}

function setMaterialOpacity(
  material: Material | Material[],
  opacity: number,
): void {
  if (Array.isArray(material)) {
    for (const item of material) item.opacity = opacity;
    return;
  }
  material.opacity = opacity;
}

function disposeDrawable(drawable: {
  geometry: BufferGeometry;
  material: Material | Material[];
  parent: Mesh["parent"];
}): void {
  drawable.geometry.dispose();
  for (const material of materialList(drawable.material)) material.dispose();
  drawable.parent?.remove(drawable as unknown as Mesh);
}

function paletteColor(level: number, offset = 0): number {
  const index = Math.abs(Math.trunc(level) + offset) % PALETTE.length;
  return PALETTE[index] ?? PALETTE[0];
}

export class StackScene {
  private readonly canvas: HTMLCanvasElement;
  private readonly reducedMotion: boolean;
  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly floor: Mesh;
  private readonly platform: Mesh;
  private readonly grid: GridHelper;
  private readonly blocks = new Map<string, BlockRecord>();
  private readonly fallingFragments: FallingFragment[] = [];
  private readonly celebrations: Celebration[] = [];
  private readonly cameraPosition = new Vector3();
  private readonly cameraLookAt = new Vector3();
  private readonly desiredCameraPosition = new Vector3();
  private readonly desiredCameraLookAt = new Vector3();
  private readonly effectOrigin = new Vector3();
  private active: BlockRecord | null = null;
  private syncedBlocks: readonly StackBlockVisual[] | null = null;
  private targetCameraY = 0;
  private elapsedSeconds = 0;
  private narrowViewport = false;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, reducedMotion: boolean) {
    this.canvas = canvas;
    this.reducedMotion = reducedMotion;
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;

    this.scene = new Scene();
    const background = new Color(0x111411);
    this.scene.background = background;
    this.scene.fog = new Fog(background, 18, 58);

    this.camera = new PerspectiveCamera(34, 1, 0.1, 100);
    this.cameraPosition.set(8.8, 8.1, 8.8);
    this.cameraLookAt.set(0, 0.65, 0);
    this.camera.position.copy(this.cameraPosition);
    this.camera.lookAt(this.cameraLookAt);

    this.scene.add(new HemisphereLight(0xa7ded2, 0x17120e, 1.5));
    const ambient = new AmbientLight(0x706a5b, 0.42);
    this.scene.add(ambient);

    const keyLight = new DirectionalLight(0xffe5c4, 2.35);
    keyLight.position.set(-7, 15, 8);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = 55;
    keyLight.shadow.camera.left = -15;
    keyLight.shadow.camera.right = 15;
    keyLight.shadow.camera.top = 15;
    keyLight.shadow.camera.bottom = -15;
    keyLight.shadow.bias = -0.0004;
    this.scene.add(keyLight);

    const fillLight = new DirectionalLight(0xf28b7d, 0.72);
    fillLight.position.set(8, 7, -9);
    this.scene.add(fillLight);

    const floorMaterial = new MeshStandardMaterial({
      color: 0x171a16,
      roughness: 0.96,
      metalness: 0.02,
    });
    this.floor = new Mesh(new PlaneGeometry(80, 80), floorMaterial);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = -0.09;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);

    const platformMaterial = new MeshStandardMaterial({
      color: 0x292d26,
      roughness: 0.68,
      metalness: 0.16,
      emissive: 0x0c120d,
      emissiveIntensity: 0.4,
    });
    this.platform = new Mesh(
      new CylinderGeometry(4.4, 4.75, 0.18, 48),
      platformMaterial,
    );
    this.platform.position.y = 0;
    this.platform.receiveShadow = true;
    this.platform.castShadow = true;
    this.scene.add(this.platform);

    this.grid = new GridHelper(32, 32, 0x59675b, 0x30372f);
    this.grid.position.y = 0.1;
    const gridMaterials = materialList(this.grid.material);
    for (const material of gridMaterials) {
      material.transparent = true;
      material.opacity = 0.32;
      material.depthWrite = false;
    }
    this.scene.add(this.grid);

    this.resize();
  }

  resize(): void {
    if (this.disposed) return;
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(
      1,
      Math.floor(rect.width || this.canvas.clientWidth || this.canvas.width || 1),
    );
    const height = Math.max(
      1,
      Math.floor(rect.height || this.canvas.clientHeight || this.canvas.height || 1),
    );
    const aspect = width / height;
    this.narrowViewport = aspect < 0.76;
    this.camera.aspect = aspect;
    this.camera.fov = this.narrowViewport ? 39 : 34;
    this.camera.updateProjectionMatrix();
    const devicePixelRatio =
      typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(devicePixelRatio);
    this.renderer.setSize(width, height, false);
  }

  sync(blocks: readonly StackBlockVisual[], active: StackBlockVisual | null): void {
    if (this.disposed) return;

    const topBlock = blocks[blocks.length - 1];
    const highestLevel = Math.max(
      active === null ? 0 : levelValue(active.level),
      topBlock === undefined ? 0 : levelValue(topBlock.level),
    );
    this.targetCameraY = Math.max(0, highestLevel * BLOCK_HEIGHT - 0.52);

    if (blocks !== this.syncedBlocks) {
      const firstVisibleIndex = Math.max(
        0,
        blocks.length - STACK_GAME_BLOCK_HISTORY_LIMIT,
      );
      const seen = new Set<string>();
      for (let index = firstVisibleIndex; index < blocks.length; index += 1) {
        const visual = blocks[index];
        if (visual === undefined || typeof visual.id !== "string") continue;
        seen.add(visual.id);
        const existing = this.blocks.get(visual.id);
        if (existing === undefined) {
          this.blocks.set(visual.id, this.createBlockRecord(visual, false));
        } else {
          this.updateBlockRecord(existing, visual, false);
        }
      }
      for (const [id, record] of this.blocks) {
        if (seen.has(id)) continue;
        this.removeBlockRecord(record);
        this.blocks.delete(id);
      }
      this.syncedBlocks = blocks;
    }

    if (active === null) {
      if (this.active !== null) {
        this.removeBlockRecord(this.active);
        this.active = null;
      }
    } else if (this.active === null || this.active.visual.id !== active.id) {
      if (this.active !== null) this.removeBlockRecord(this.active);
      this.active = this.createBlockRecord(active, true);
    } else {
      this.updateBlockRecord(this.active, active, true);
    }
  }

  dropFragment(fragment: StackFragmentVisual): void {
    this.spawnFallingFragment(fragment, false);
  }

  celebratePerfect(level: number, streak: number): void {
    if (this.disposed || this.reducedMotion) return;
    if (this.celebrations.length >= MAX_CELEBRATIONS) {
      const oldest = this.celebrations.shift();
      if (oldest !== undefined) this.removeCelebration(oldest);
    }

    const origin = this.findEffectOrigin(level);
    const safeLevel = levelValue(level);
    const streakScale = 1 + Math.min(20, Math.max(0, finiteValue(streak, 0))) * 0.035;
    const color = paletteColor(safeLevel, Math.trunc(streak));
    const ringMaterial = new MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    const ring = new Mesh(new RingGeometry(0.24, 0.31, 32), ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(origin.x, stackY(safeLevel) + 0.25, origin.z);
    ring.scale.setScalar(0.7);
    this.scene.add(ring);

    const count = Math.min(24, 12 + Math.max(0, Math.min(12, Math.trunc(streak))));
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
      const angle = (index / count) * Math.PI * 2;
      const radius = 0.28 + (index % 3) * 0.055;
      const offset = index * 3;
      positions[offset] = Math.cos(angle) * radius;
      positions[offset + 1] = 0.03 + (index % 4) * 0.035;
      positions[offset + 2] = Math.sin(angle) * radius;
      velocities[offset] = Math.cos(angle) * (0.65 + (index % 2) * 0.15);
      velocities[offset + 1] = 1.1 + (index % 4) * 0.13;
      velocities[offset + 2] = Math.sin(angle) * (0.65 + (index % 2) * 0.15);
    }
    const particleGeometry = new BufferGeometry();
    particleGeometry.setAttribute(
      "position",
      new Float32BufferAttribute(positions, 3),
    );
    const particleMaterial = new PointsMaterial({
      color,
      size: 0.095,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    const particles = new Points(particleGeometry, particleMaterial);
    particles.position.set(origin.x, ring.position.y, origin.z);
    this.scene.add(particles);
    this.celebrations.push({
      ring,
      particles,
      positions,
      velocities,
      count,
      life: 0,
      maxLife: 0.72 + Math.min(0.14, streakScale * 0.025),
    });
  }

  dropMiss(fragment: StackFragmentVisual): void {
    this.spawnFallingFragment(fragment, true);
  }

  render(deltaSeconds: number): void {
    if (this.disposed) return;
    const delta = Math.min(
      0.08,
      Math.max(0, finiteValue(deltaSeconds, 0)),
    );
    if (!this.reducedMotion) this.elapsedSeconds += delta;

    for (const record of this.blocks.values()) {
      if (record.dropOffset > 0) {
        record.dropOffset = Math.max(0, record.dropOffset - delta * 1.8);
        record.mesh.position.y = record.restY + record.dropOffset;
      } else {
        record.mesh.position.y = record.restY;
      }
    }
    if (this.active !== null) {
      const hover = this.reducedMotion
        ? 0
        : Math.sin(this.elapsedSeconds * 2.7) * 0.055;
      this.active.mesh.position.y = this.active.restY + hover;
      // Keep the moving block axis-aligned so the visible edge remains an
      // honest timing guide for the overlap calculation.
      this.active.mesh.rotation.y = 0;
    }

    this.updateFallingFragments(delta);
    this.updateCelebrations(delta);
    this.updateCamera(delta);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const record of this.blocks.values()) this.removeBlockRecord(record);
    this.blocks.clear();
    this.syncedBlocks = null;
    if (this.active !== null) {
      this.removeBlockRecord(this.active);
      this.active = null;
    }
    for (const fragment of this.fallingFragments) this.removeFallingFragment(fragment);
    this.fallingFragments.length = 0;
    for (const celebration of this.celebrations) this.removeCelebration(celebration);
    this.celebrations.length = 0;

    disposeDrawable(this.floor);
    disposeDrawable(this.platform);
    disposeDrawable(this.grid);
    this.scene.clear();
    this.renderer.dispose();
  }

  private createBlockRecord(
    visual: StackBlockVisual,
    active: boolean,
  ): BlockRecord {
    const width = dimensionValue(visual.width);
    const depth = dimensionValue(visual.depth);
    const restY = stackY(visual.level);
    const material = new MeshStandardMaterial({
      color: paletteColor(visual.level),
      roughness: active ? 0.32 : 0.42,
      metalness: active ? 0.14 : 0.08,
      emissive: paletteColor(visual.level),
      emissiveIntensity: active ? 0.2 : 0.075,
    });
    const mesh = new Mesh(
      new BoxGeometry(width, BLOCK_HEIGHT, depth),
      material,
    );
    mesh.position.set(
      coordinateValue(visual.x),
      restY + (active || this.reducedMotion ? 0 : 0.16),
      coordinateValue(visual.z),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    return {
      visual,
      mesh,
      width,
      depth,
      restY,
      dropOffset: active || this.reducedMotion ? 0 : 0.16,
      active,
    };
  }

  private updateBlockRecord(
    record: BlockRecord,
    visual: StackBlockVisual,
    active: boolean,
  ): void {
    const width = dimensionValue(visual.width);
    const depth = dimensionValue(visual.depth);
    if (Math.abs(record.width - width) > 0.0001 || Math.abs(record.depth - depth) > 0.0001) {
      record.mesh.geometry.dispose();
      record.mesh.geometry = new BoxGeometry(width, BLOCK_HEIGHT, depth);
      record.width = width;
      record.depth = depth;
    }
    record.visual = visual;
    record.restY = stackY(visual.level);
    record.mesh.position.x = coordinateValue(visual.x);
    record.mesh.position.z = coordinateValue(visual.z);
    record.active = active;
  }

  private removeBlockRecord(record: BlockRecord): void {
    disposeDrawable(record.mesh);
  }

  private spawnFallingFragment(
    fragment: StackFragmentVisual,
    miss: boolean,
  ): void {
    if (this.disposed || this.reducedMotion) return;
    if (this.fallingFragments.length >= MAX_FALLING_FRAGMENTS) {
      const oldest = this.fallingFragments.shift();
      if (oldest !== undefined) this.removeFallingFragment(oldest);
    }

    const width = dimensionValue(fragment.width);
    const depth = dimensionValue(fragment.depth);
    const safeLevel = levelValue(fragment.level);
    const color = miss ? 0xf27a6d : paletteColor(safeLevel);
    const material = new MeshStandardMaterial({
      color,
      roughness: 0.46,
      metalness: 0.06,
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
      emissive: color,
      emissiveIntensity: miss ? 0.12 : 0.075,
    });
    const mesh = new Mesh(new BoxGeometry(width, BLOCK_HEIGHT, depth), material);
    const direction = fragment.side === "negative" ? -1 : 1;
    const axisVelocity = miss ? 1.15 : 0.84;
    mesh.position.set(
      coordinateValue(fragment.x),
      stackY(safeLevel),
      coordinateValue(fragment.z),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.fallingFragments.push({
      mesh,
      velocity: new Vector3(
        fragment.axis === "x" ? direction * axisVelocity : direction * 0.34,
        miss ? 0.72 : 1.05,
        fragment.axis === "z" ? direction * axisVelocity : direction * 0.34,
      ),
      spin: new Vector3(
        fragment.axis === "x" ? 0.9 : 1.5,
        direction * (miss ? 1.7 : 1.15),
        fragment.axis === "z" ? 0.9 : 1.5,
      ),
      life: 0,
      maxLife: miss ? 1.25 : 1.45,
    });
  }

  private updateFallingFragments(delta: number): void {
    for (let index = this.fallingFragments.length - 1; index >= 0; index -= 1) {
      const fragment = this.fallingFragments[index];
      if (fragment === undefined) continue;
      fragment.life += delta;
      fragment.velocity.y -= FALLING_GRAVITY * delta;
      fragment.mesh.position.x += fragment.velocity.x * delta;
      fragment.mesh.position.y += fragment.velocity.y * delta;
      fragment.mesh.position.z += fragment.velocity.z * delta;
      fragment.mesh.rotation.x += fragment.spin.x * delta;
      fragment.mesh.rotation.y += fragment.spin.y * delta;
      fragment.mesh.rotation.z += fragment.spin.z * delta;
      const progress = Math.min(1, fragment.life / fragment.maxLife);
      const material = fragment.mesh.material;
      setMaterialOpacity(material, 0.96 * (1 - progress * progress));
      if (fragment.life >= fragment.maxLife || fragment.mesh.position.y < -0.45) {
        this.fallingFragments.splice(index, 1);
        this.removeFallingFragment(fragment);
      }
    }
  }

  private removeFallingFragment(fragment: FallingFragment): void {
    disposeDrawable(fragment.mesh);
  }

  private updateCelebrations(delta: number): void {
    for (let index = this.celebrations.length - 1; index >= 0; index -= 1) {
      const celebration = this.celebrations[index];
      if (celebration === undefined) continue;
      celebration.life += delta;
      const progress = Math.min(1, celebration.life / celebration.maxLife);
      const remaining = 1 - progress;
      celebration.ring.scale.setScalar(0.7 + progress * 1.85);
      setMaterialOpacity(celebration.ring.material, 0.92 * remaining);

      const positions = celebration.positions;
      const velocities = celebration.velocities;
      for (let particle = 0; particle < celebration.count; particle += 1) {
        const offset = particle * 3;
        positions[offset] = (positions[offset] ?? 0) + (velocities[offset] ?? 0) * delta;
        positions[offset + 1] = (positions[offset + 1] ?? 0) + (velocities[offset + 1] ?? 0) * delta;
        positions[offset + 2] = (positions[offset + 2] ?? 0) + (velocities[offset + 2] ?? 0) * delta;
        velocities[offset + 1] = (velocities[offset + 1] ?? 0) - 3.4 * delta;
      }
      const particlePosition = celebration.particles.geometry.getAttribute("position");
      particlePosition.needsUpdate = true;
      setMaterialOpacity(celebration.particles.material, 0.95 * remaining);
      if (celebration.life >= celebration.maxLife) {
        this.celebrations.splice(index, 1);
        this.removeCelebration(celebration);
      }
    }
  }

  private removeCelebration(celebration: Celebration): void {
    disposeDrawable(celebration.ring);
    disposeDrawable(celebration.particles);
  }

  private findEffectOrigin(level: number): Vector3 {
    const safeLevel = levelValue(level);
    let x = 0;
    let z = 0;
    let found = false;
    if (this.active !== null && levelValue(this.active.visual.level) === safeLevel) {
      x = coordinateValue(this.active.visual.x);
      z = coordinateValue(this.active.visual.z);
      found = true;
    }
    if (!found) {
      for (const record of this.blocks.values()) {
        if (levelValue(record.visual.level) !== safeLevel) continue;
        x = coordinateValue(record.visual.x);
        z = coordinateValue(record.visual.z);
        found = true;
        break;
      }
    }
    if (!found && this.active !== null) {
      x = coordinateValue(this.active.visual.x);
      z = coordinateValue(this.active.visual.z);
    }
    this.effectOrigin.set(x, stackY(safeLevel), z);
    return this.effectOrigin;
  }

  private updateCamera(delta: number): void {
    const targetY = this.targetCameraY;
    const smoothing = this.reducedMotion
      ? 1
      : Math.min(1, 1 - Math.exp(-delta * 5.4));
    this.cameraLookAt.y += (targetY - this.cameraLookAt.y) * smoothing;
    this.desiredCameraLookAt.set(0, this.cameraLookAt.y, 0);
    const distance = this.narrowViewport ? 11.8 : 9.4;
    const height = this.narrowViewport ? 9.8 : 8.1;
    this.desiredCameraPosition.set(
      distance,
      this.cameraLookAt.y + height,
      distance,
    );
    this.cameraPosition.lerp(this.desiredCameraPosition, smoothing);
    this.camera.position.copy(this.cameraPosition);
    this.camera.lookAt(this.desiredCameraLookAt);
  }
}

function stackY(level: number): number {
  return levelValue(level) * BLOCK_HEIGHT + BLOCK_HEIGHT / 2;
}
