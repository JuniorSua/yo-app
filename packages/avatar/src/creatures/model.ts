import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { CreatureId, CreatureState } from "./meta";
import { armPose } from "./poses";

export * from "./meta";

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
function material(color: string, roughness = 0.42) {
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness,
    metalness: 0,
    clearcoat: 0.22,
    clearcoatRoughness: 0.45,
  });
}

/** `detail: "avatar"` uses lighter geometry (avatars are at most a few hundred px; the workshop keeps "full"). */
export function buildCreature(id: CreatureId, { detail = "full" }: { detail?: "full" | "avatar" } = {}) {
  const lite = detail === "avatar";
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const palette =
    id === "sprout"
      ? ["#a8c962", "#c4db88", "#688e42", "#dc815a"]
      : id === "pebble"
        ? ["#eca387", "#f6c7a6", "#bd715d", "#8d5344"]
        : ["#b8a7da", "#dbcaed", "#8874ad", "#e5ae77"];
  const skin = material(palette[0]!);
  const light = material(palette[1]!);
  const dark = material(palette[2]!);
  const glove = material(palette[3]!);
  const cream = material("#fff5dd", 0.58);
  const black = material("#27352e", 0.32);
  const blush = material(id === "mimi" ? "#dc9fb6" : "#ec917c", 0.65);
  const eyeWhite = material("#fffef1", 0.23);
  const pupil = material("#192c24", 0.15);
  const metal = material("#d7d6b8", 0.32);
  const sphereGeometry = lite ? new THREE.SphereGeometry(1, 18, 12) : new THREE.SphereGeometry(1, 40, 28);
  const sphere = (parent: THREE.Object3D, mat: THREE.Material, pos: number[], scale: number[]) => {
    const mesh = new THREE.Mesh(sphereGeometry, mat);
    mesh.position.set(pos[0]!, pos[1]!, pos[2]!);
    mesh.scale.set(scale[0]!, scale[1]!, scale[2]!);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const tube = (parent: THREE.Object3D, mat: THREE.Material, points: THREE.Vector3[], radius: number) => {
    const curve = new THREE.CatmullRomCurve3(points);
    const mesh = new THREE.Mesh(
      new THREE.TubeGeometry(curve, lite ? 12 : 32, radius, lite ? 6 : 10, false),
      mat,
    );
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };
  // Sculpted overlapping volumes keep the silhouette readable at avatar sizes.
  if (id === "sprout") {
    sphere(body, dark, [0, 0.6, -0.17], [0.84, 0.55, 0.66]);
    sphere(body, skin, [0, 0.93, 0], [0.88, 0.51, 0.67]);
    sphere(body, light, [0, 1.36, 0.06], [0.77, 0.45, 0.61]);
    sphere(body, skin, [0, 1.75, 0], [0.69, 0.43, 0.57]);
    for (const s of [-1, 1]) {
      sphere(body, glove, [s * 0.48, 0.21, 0.24], [0.3, 0.18, 0.4]);
      sphere(body, dark, [s * 0.66, 0.45, -0.2], [0.23, 0.2, 0.29]);
    }
  } else if (id === "pebble") {
    sphere(body, dark, [0, 1.0, -0.24], [0.9, 0.93, 0.65]);
    for (const s of [-1, 1]) {
      const shell = sphere(body, skin, [s * 0.35, 1.04, -0.1], [0.5, 0.83, 0.63]);
      shell.rotation.z = s * -0.13;
      sphere(body, glove, [s * 0.43, 0.2, 0.24], [0.27, 0.2, 0.41]);
      for (const y of [0.75, 1.12]) sphere(body, dark, [s * 0.73, y, 0.27], [0.085, 0.11, 0.045]);
    }
    sphere(body, light, [0, 0.92, 0.44], [0.6, 0.64, 0.22]);
  } else {
    sphere(body, skin, [0, 1.04, 0], [0.56, 0.82, 0.5]);
    sphere(body, light, [0, 0.95, 0.4], [0.37, 0.53, 0.16]);
    for (const s of [-1, 1]) sphere(body, dark, [s * 0.28, 0.21, 0.15], [0.22, 0.18, 0.35]);
  }
  const wings: THREE.Group[] = [];
  if (id === "mimi") {
    for (const s of [-1, 1]) {
      const wing = new THREE.Group();
      wing.position.set(s * 0.29, 1.26, -0.25);
      body.add(wing);
      const upper = sphere(wing, light, [s * 0.56, 0.24, -0.08], [0.57, 0.85, 0.14]);
      upper.rotation.z = s * -0.57;
      const lower = sphere(wing, skin, [s * 0.46, -0.34, -0.06], [0.48, 0.48, 0.15]);
      lower.rotation.z = s * 0.35;
      const inset = sphere(wing, cream, [s * 0.68, 0.4, 0.04], [0.26, 0.48, 0.055]);
      inset.rotation.z = s * -0.57;
      sphere(wing, dark, [s * 0.57, -0.37, 0.09], [0.19, 0.21, 0.035]);
      wings.push(wing);
    }
  }
  const head = new THREE.Group();
  head.position.y = id === "sprout" ? 2.1 : 2.02;
  body.add(head);
  sphere(head, skin, [0, 0, 0], [0.74, 0.65, 0.59]).name = "barrier-head";
  sphere(head, light, [0, -0.22, 0.29], [0.7, 0.4, 0.39]).name = "barrier-cheek";
  const eyes: THREE.Group[] = [];
  const pupils: THREE.Mesh[] = [];
  for (const s of [-1, 1]) {
    const eye = new THREE.Group();
    eye.position.set(s * 0.235, 0.08, 0.52);
    head.add(eye);
    sphere(eye, eyeWhite, [0, 0, 0], [0.205, 0.255, 0.105]);
    const iris = sphere(eye, pupil, [0.012, -0.004, 0.095], [0.099, 0.139, 0.048]);
    sphere(iris, eyeWhite, [-0.29, 0.38, 0.8], [0.23, 0.19, 0.19]);
    eyes.push(eye);
    pupils.push(iris);
    sphere(head, blush, [s * 0.46, -0.21, 0.548], [0.14, 0.077, 0.025]);
    tube(head, dark, [v(s * 0.14, 0.4, 0.51), v(s * 0.24, 0.425, 0.505), v(s * 0.32, 0.395, 0.48)], 0.035);
  }
  sphere(head, light, [0, -0.12, 0.66], [0.145, 0.11, 0.095]);
  tube(head, dark, [v(-0.19, -0.32, 0.614), v(0, -0.39, 0.645), v(0.19, -0.32, 0.614)], 0.025);
  const antennae: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    const antenna = new THREE.Group();
    antenna.position.set(s * 0.33, 0.5, -0.01);
    head.add(antenna);
    const tall = id === "mimi" ? 0.64 : id === "sprout" ? 0.52 : 0.28;
    tube(
      antenna,
      id === "mimi" ? dark : skin,
      [v(0, 0, 0), v(s * 0.08, tall * 0.65, 0.01), v(s * 0.2, tall, 0.025)],
      0.052,
    );
    sphere(
      antenna,
      glove,
      [s * 0.2, tall, 0.025],
      id === "mimi" ? [0.115, 0.18, 0.095] : [0.115, 0.13, 0.115],
    );
    antennae.push(antenna);
  }
  const headset = new THREE.Group();
  head.add(headset);
  const arc = Array.from({ length: 25 }, (_, i) => {
    const a = (i / 24) * Math.PI;
    return v(Math.cos(a) * 0.78, Math.sin(a) * 0.68 + 0.02, -0.12);
  });
  tube(headset, black, arc, 0.07);
  tube(
    headset,
    cream,
    arc.map((p) => p.clone().add(v(0, 0.043, 0))),
    0.036,
  );
  for (const s of [-1, 1]) {
    sphere(headset, black, [s * 0.72, 0.03, -0.01], [0.145, 0.275, 0.255]).name = `barrier-ear-${s}`;
    sphere(headset, cream, [s * 0.82, 0.035, 0.0], [0.095, 0.215, 0.195]).name = `barrier-ear-outer-${s}`;
    sphere(headset, metal, [s * 0.897, 0.035, 0.0], [0.018, 0.113, 0.1]);
  }
  tube(
    headset,
    black,
    [v(0.83, -0.07, 0.05), v(0.81, -0.31, 0.42), v(0.53, -0.36, 0.69), v(0.3, -0.32, 0.73)],
    0.035,
  );
  sphere(headset, black, [0.29, -0.32, 0.73], [0.115, 0.068, 0.068]).name = "barrier-microphone";
  sphere(headset, material("#c9eb8a"), [0.29, -0.312, 0.79], [0.032, 0.025, 0.01]);

  // Articulated arms follow explicit targets, so gestures cannot swing through the face.
  const hands: {
    upper: THREE.Mesh;
    forearm: THREE.Mesh;
    joint: THREE.Mesh;
    mitten: THREE.Group;
    side: number;
    row: number;
  }[] = [];
  const rows = id === "sprout" ? 2 : 1;
  for (let row = 0; row < rows; row++) {
    for (const side of [-1, 1]) {
      const upper = sphere(body, skin, [0, 0, 0], [0.13, 0.2, 0.13]);
      const forearm = sphere(body, skin, [0, 0, 0], [0.12, 0.2, 0.12]);
      const joint = sphere(body, skin, [0, 0, 0], [0.14, 0.14, 0.14]);
      upper.name = `arm-upper-${row}-${side}`;
      forearm.name = `arm-forearm-${row}-${side}`;
      joint.name = `arm-elbow-${row}-${side}`;
      const mitten = new THREE.Group();
      mitten.name = `hand-${row}-${side}`;
      body.add(mitten);
      sphere(mitten, glove, [0, 0, 0], [0.19, 0.16, 0.13]);
      for (let f = 0; f < 3; f++) {
        sphere(
          mitten,
          glove,
          [side * (0.03 + f * 0.063), 0.082 + Math.sin(f) * 0.01, 0.01],
          [0.055, 0.12 - f * 0.012, 0.075],
        );
      }
      sphere(mitten, glove, [-side * 0.13, 0.055, 0.065], [0.075, 0.105, 0.075]);
      mitten.children.forEach((mesh, i) => {
        mesh.name = `glove-${row}-${side}-${i}`;
      });
      hands.push({ upper, forearm, joint, mitten, side, row });
    }
  }

  // The screen faces the character; its back and small enamel logo face the viewer.
  const laptop = new THREE.Group();
  laptop.name = "laptop";
  body.add(laptop);
  const chassis = material("#56695e", 0.35);
  const edge = material("#b9c7b3", 0.4);
  const screen = material("#253c35", 0.6);
  const keycap = material("#738b7c", 0.65);
  const box = (parent: THREE.Object3D, mat: THREE.Material, size: number[], pos: number[], radius = 0.03) => {
    const mesh = new THREE.Mesh(new RoundedBoxGeometry(size[0]!, size[1]!, size[2]!, 2, radius), mat);
    mesh.position.set(pos[0]!, pos[1]!, pos[2]!);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  box(laptop, chassis, [1.5, 0.075, 0.79], [0, 0, 0]);
  box(laptop, edge, [1.44, 0.018, 0.74], [0, 0.043, 0], 0.007);
  // Many small boxes of one material are merged into one mesh (one draw call instead of ~30).
  const boxes = (parent: THREE.Object3D, mat: THREE.Material, list: [number[], number[], number][]) => {
    const parts = list.map(([size, pos, radius]) =>
      new RoundedBoxGeometry(size[0]!, size[1]!, size[2]!, 2, radius).translate(pos[0]!, pos[1]!, pos[2]!),
    );
    const mesh = new THREE.Mesh(mergeGeometries(parts), mat);
    for (const p of parts) p.dispose();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const keys: [number[], number[], number][] = [[[0.38, 0.008, 0.14], [0, 0.058, -0.22], 0.003]];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 10; c++) {
      keys.push([[0.106, 0.021, 0.081], [-0.565 + c * 0.126, 0.065, -0.06 + r * 0.102], 0.008]);
    }
  }
  boxes(laptop, keycap, keys);
  const lid = new THREE.Group();
  lid.name = "laptop-lid";
  lid.position.set(0, 0.02, 0.365);
  laptop.add(lid);
  box(lid, chassis, [1.5, 0.62, 0.065], [0, 0.305, 0]);
  box(lid, edge, [1.43, 0.55, 0.016], [0, 0.305, -0.037], 0.01);
  box(lid, screen, [1.32, 0.45, 0.012], [0, 0.315, -0.048], 0.005);
  const code = material("#badca1", 0.8);
  boxes(
    lid,
    code,
    [0, 1, 2, 3].map((line) => [
      [0.34 + (line % 2) * 0.3, 0.018, 0.008],
      [-0.14, 0.46 - line * 0.075, -0.058],
      0.003,
    ]),
  );
  sphere(lid, cream, [0, 0.32, 0.045], [0.105, 0.105, 0.014]);
  sphere(lid, dark, [0, 0.32, 0.059], [0.033, 0.05, 0.005]);
  const axis = v(0, 1, 0);
  const from = new THREE.Vector3();
  const to = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const connect = (mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3, radius: number) => {
    direction.subVectors(b, a);
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.scale.set(radius, direction.length() * 0.5 + 0.055, radius);
    mesh.quaternion.setFromUnitVectors(axis, direction.normalize());
  };
  const thought = new THREE.Group();
  thought.name = "thought-cloud";
  body.add(thought);
  const cloudMaterial = material("#fffef8", 0.82);
  sphere(thought, cloudMaterial, [-0.23, 0, 0], [0.23, 0.17, 0.09]);
  sphere(thought, cloudMaterial, [-0.07, 0.065, 0], [0.24, 0.205, 0.1]);
  sphere(thought, cloudMaterial, [0.14, 0.035, 0], [0.23, 0.19, 0.1]);
  sphere(thought, cloudMaterial, [0.28, -0.015, 0], [0.17, 0.14, 0.08]);
  sphere(thought, cloudMaterial, [-0.26, -0.22, 0], [0.07, 0.06, 0.05]);
  sphere(thought, cloudMaterial, [-0.37, -0.34, 0], [0.043, 0.037, 0.035]);
  for (const x of [-0.14, 0, 0.14]) sphere(thought, dark, [x, 0.01, 0.105], [0.027, 0.032, 0.012]);
  const cloth = new THREE.Group();
  cloth.name = "polishing-cloth";
  body.add(cloth);
  const microfiber = material("#f7df95", 0.95);
  box(cloth, microfiber, [0.48, 0.4, 0.028], [0, 0, 0], 0.012);
  box(cloth, cream, [0.42, 0.011, 0.006], [0, -0.15, 0.018], 0.003);
  const cleaningTarget = new THREE.Vector3();
  const clothContact = new THREE.Vector3();
  const lidToBody = new THREE.Matrix4();
  let cleanBlend = 0;
  let workBlend = 0;
  let previousTime: number | undefined;
  // A tiny enamel badge gives each helper a tactile, designed-object detail.
  sphere(body, cream, [0, 1.38, id === "sprout" ? 0.667 : 0.66], [0.12, 0.13, 0.025]);
  sphere(body, dark, [0, 1.39, id === "sprout" ? 0.695 : 0.69], [0.035, 0.054, 0.012]);

  function animate(t: number, state: CreatureState, pointer: number, hasHeadset: boolean) {
    const working = state === "working";
    const done = state === "done";
    const hasLaptop = working || done;
    const delta = previousTime === undefined ? 0 : Math.max(0, Math.min(t - previousTime, 1));
    previousTime = t;
    // Frozen/reduced-motion previews settle immediately; live changes deploy the laptop smoothly.
    workBlend =
      delta === 0 ? Number(hasLaptop) : THREE.MathUtils.damp(workBlend, Number(hasLaptop), 7, delta);
    cleanBlend = delta === 0 ? Number(done) : THREE.MathUtils.damp(cleanBlend, Number(done), 7, delta);
    const questioning = state === "question";
    const sleeping = state === "sleeping";
    const thinking = state === "thinking";
    body.position.y = Math.sin(t * (working ? 3 : 1.7)) * 0.025;
    body.rotation.z = Math.sin(t * 1.5) * 0.015;
    root.rotation.y = -0.22 + pointer * 0.35;
    head.rotation.z =
      thinking || questioning ? -0.08 + Math.sin(t) * 0.018 : sleeping ? 0.06 : Math.sin(t * 1.3) * 0.02;
    head.rotation.x = sleeping ? 0.1 : workBlend * (0.21 + Math.sin(t * 2) * 0.012);
    head.rotation.y = thinking ? Math.sin(t * 0.7) * 0.13 : Math.sin(t * 0.8) * 0.04;
    const blink = Math.sin(t * 0.91) > 0.994 ? 0.09 : 1;
    eyes.forEach((eye) => {
      eye.scale.y = sleeping ? 0.075 : blink;
    });
    pupils.forEach((p) => {
      p.position.x = 0.012 + Math.sin(t * (working ? 2.4 : 0.6)) * 0.025;
      p.position.y = thinking ? 0.04 : -0.004 - workBlend * 0.045;
    });
    laptop.visible = workBlend > 0.015;
    laptop.position.set(-0.42 * (1 - workBlend), 0.55 + 0.47 * workBlend, 0.85 + 0.29 * workBlend);
    laptop.rotation.z = -0.12 * (1 - workBlend);
    laptop.scale.setScalar(0.72 + 0.28 * workBlend);
    lid.rotation.x = -1.55 + 1.39 * workBlend;
    laptop.updateMatrix();
    lid.updateMatrix();
    lidToBody.multiplyMatrices(laptop.matrix, lid.matrix);
    // Wipe across the outside of the lid, with a cloth between palm and casing.
    const wipeX = 0.2 + Math.sin(t * 3) * 0.24;
    const wipeY = 0.31 + Math.sin(t * 6) * 0.06;
    cleaningTarget.set(wipeX, wipeY, 0.197).applyMatrix4(lidToBody);
    clothContact.set(wipeX, wipeY, 0.052).applyMatrix4(lidToBody);
    cloth.visible = cleanBlend > 0.96 && workBlend > 0.96;
    cloth.position.copy(clothContact);
    cloth.rotation.set(lid.rotation.x, 0, laptop.rotation.z);
    cloth.rotateZ(Math.sin(t * 3) * 0.12);
    thought.visible = thinking;
    thought.position.set(0.4, 3.37 + Math.sin(t * 1.5) * 0.025, 0.35);
    hands.forEach(({ upper, forearm, joint, mitten, side, row }) => {
      const rest = armPose(id, side, row, t, hasLaptop ? "idle" : state);
      const work = armPose(id, side, row, t, "working");
      from.fromArray(rest.shoulder);
      joint.position.fromArray(rest.elbow).lerp(to.fromArray(work.elbow), workBlend);
      connect(upper, from, joint.position, 0.135);
      mitten.position.fromArray(rest.hand).lerp(to.fromArray(work.hand), workBlend);
      mitten.rotation.set(
        THREE.MathUtils.lerp(rest.pitch, work.pitch, workBlend),
        0,
        THREE.MathUtils.lerp(rest.roll, work.roll, workBlend),
      );
      if (side === -1 && (row === 1) === (id === "sprout") && laptop.visible) {
        // Keep the palm attached during opening AND stowing, not just the settled pose.
        mitten.position.set(-0.63, -0.185 / laptop.scale.y, 0).applyMatrix4(laptop.matrix);
        mitten.rotation.set(-Math.PI / 2, 0, laptop.rotation.z);
      }
      if (side === 1 && row === 0 && cleanBlend > 0) {
        // Route around the right edge before crossing to the front of the lid.
        // A straight interpolation from the keyboard would pass through the screen.
        const reach = v(1.12, 1.25, 1.03);
        const around = v(1.12, 1.35, 1.77);
        if (cleanBlend < 0.3) mitten.position.lerp(reach, cleanBlend / 0.3);
        else if (cleanBlend < 0.6) mitten.position.copy(reach).lerp(around, (cleanBlend - 0.3) / 0.3);
        else mitten.position.copy(around).lerp(cleaningTarget, (cleanBlend - 0.6) / 0.4);
        joint.position.lerp(to.set(1.05, 1.16, 1.62), Math.min(1, cleanBlend / 0.6));
        mitten.rotation.x = THREE.MathUtils.lerp(mitten.rotation.x, lid.rotation.x, cleanBlend);
        mitten.rotation.z *= 1 - cleanBlend;
        connect(upper, from, joint.position, 0.135);
      }
      connect(forearm, joint.position, mitten.position, 0.12);
    });
    antennae.forEach((a, i) => {
      a.rotation.z = Math.sin(t * 2 + i) * 0.065;
    });
    wings.forEach((w, i) => {
      w.rotation.y =
        (i === 0 ? 1 : -1) * (0.12 + Math.sin(t * (working ? 8 : 2)) * (sleeping ? 0.015 : 0.13));
    });
    headset.visible = hasHeadset;
  }
  return { root, animate, dispose: () => disposeTree(root) };
}

export type Creature = ReturnType<typeof buildCreature>;

/** Frees every geometry, material and texture under `root` (each built creature owns its own). */
export function disposeTree(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      geometries.add(obj.geometry);
      (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((m) => {
        materials.add(m);
      });
    }
  });
  geometries.forEach((g) => {
    g.dispose();
  });
  materials.forEach((m) => {
    if ("map" in m && m.map instanceof THREE.Texture) m.map.dispose();
    m.dispose();
  });
}

/**
 * The studio set every creature stands in: soft room lighting, a key light with shadows, a faint floor shadow
 * and a contact shadow. Shared by the workshop page and the app's avatar renderer.
 */
export function createStage(
  renderer: THREE.WebGLRenderer,
  opts: { shadowMap?: number | false; environment?: boolean } = {},
) {
  // `shadowMap: false` (the app's avatars): no shadow pass, which halves the work per frame. The contact
  // shadow below still grounds the creature.
  const shadows = opts.shadowMap !== false;
  renderer.shadowMap.enabled = shadows;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.98;
  const scene = new THREE.Scene();
  // `environment: false` (the app's avatars): no room reflections. Prefiltering the environment map is the
  // slowest part of start-up (seconds without a GPU); a brighter sky light stands in for its soft fill.
  let environment: THREE.WebGLRenderTarget | null = null;
  if (opts.environment !== false) {
    const environmentRoom = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(renderer);
    environment = pmrem.fromScene(environmentRoom, 0.06);
    scene.environment = environment.texture;
    scene.environmentIntensity = 0.55;
    environmentRoom.dispose();
    pmrem.dispose();
  }
  scene.add(new THREE.HemisphereLight("#fff9e8", "#89927b", environment ? 1.45 : 2.3));
  const key = new THREE.DirectionalLight("#fff7e7", 3.1);
  key.position.set(-3, 6, 5);
  key.castShadow = shadows;
  const shadowMap = opts.shadowMap || 2048;
  key.shadow.mapSize.set(shadowMap, shadowMap);
  key.shadow.camera.left = -4;
  key.shadow.camera.right = 4;
  key.shadow.camera.top = 5;
  key.shadow.camera.bottom = -3;
  key.shadow.normalBias = 0.035;
  key.shadow.bias = -0.0001;
  key.shadow.radius = 4;
  scene.add(key);
  const rim = new THREE.DirectionalLight("#ffffff", 1.8);
  rim.position.set(3, 4, -3);
  scene.add(rim);
  const fill = new THREE.DirectionalLight("#eaf0ff", 0.7);
  fill.position.set(2, 1, 5);
  scene.add(fill);
  if (shadows) {
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.ShadowMaterial({ opacity: 0.045 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.015;
    floor.receiveShadow = true;
    scene.add(floor);
  }
  // Soft contact shadow grounds the toy without an expensive post-processing pass.
  const textureCanvas = document.createElement("canvas");
  textureCanvas.width = textureCanvas.height = 128;
  const ctx = textureCanvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(64, 64, 5, 64, 64, 64);
  gradient.addColorStop(0, "rgba(35,39,25,.23)");
  gradient.addColorStop(0.45, "rgba(35,39,25,.1)");
  gradient.addColorStop(1, "rgba(35,39,25,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  const contact = new THREE.Mesh(
    new THREE.PlaneGeometry(3.4, 2.5),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(textureCanvas),
      transparent: true,
      depthWrite: false,
    }),
  );
  contact.rotation.x = -Math.PI / 2;
  contact.position.y = 0.025;
  scene.add(contact);
  return {
    scene,
    /** Frees the set (not the creatures standing in it: remove and dispose those first). */
    dispose() {
      disposeTree(scene);
      environment?.dispose();
      key.shadow.map?.dispose();
    },
  };
}

/** The workshop's canvas: its own renderer and an opaque, tinted background (?creature-lab=1 only). */
export function createCreatureScene(canvas: HTMLCanvasElement, id: CreatureId, background: string) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(background);
  const stage = createStage(renderer);
  const camera = new THREE.PerspectiveCamera(31, 1, 0.1, 50);
  camera.position.set(0.3, 3.25, 8.6);
  camera.lookAt(0, 1.65, 0);
  const creature = buildCreature(id);
  stage.scene.add(creature.root);
  let disposed = false;
  return {
    resize(width: number, height: number) {
      if (disposed || width === 0 || height === 0) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.position.z = camera.aspect < 0.8 ? 9.6 : 8.6;
      camera.updateProjectionMatrix();
    },
    render(t: number, state: CreatureState, pointer: number, headset: boolean) {
      if (disposed) return;
      renderer.setClearColor(state === "question" ? "#f5e8b9" : background);
      creature.animate(t, state, pointer, headset);
      renderer.render(stage.scene, camera);
    },
    dispose() {
      disposed = true;
      stage.dispose();
      renderer.dispose();
    },
  };
}
