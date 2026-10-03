import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { buildCreature, CREATURES, type CreatureState } from "./model";

const states: CreatureState[] = ["idle", "working", "thinking", "question", "done", "sleeping"];

describe("creature gesture clearance", () => {
  // "full" is the workshop; "avatar" is the lighter geometry the app renders. Both must keep their clearances.
  for (const detail of ["full", "avatar"] as const)
    for (const { id: kind } of CREATURES) {
      const id = kind;
      const label = `${id} (${detail})`;
      it(`${label}: arms and fingers stay outside the head, earcups, and microphone throughout gestures and transitions`, () => {
        const creature = buildCreature(id, { detail });
        const barriers: THREE.Mesh[] = [];
        const limbs: THREE.Mesh[] = [];
        creature.root.traverse((obj) => {
          if (!(obj instanceof THREE.Mesh)) return;
          if (obj.name.startsWith("barrier-")) barriers.push(obj);
          if (obj.name.startsWith("glove-") || obj.name.startsWith("arm-")) limbs.push(obj);
        });
        expect(barriers.length).toBe(7);
        const matrix = new THREE.Matrix4();
        const point = new THREE.Vector3();
        const center = new THREE.Vector3();
        let worst = 10;
        let worstAt = "";
        let time = 0;
        // Walk every state-to-state path as well as a complete slow motion cycle.
        const sequence = [...states, ...states.flatMap((a) => states.flatMap((b) => [a, b]))];
        for (const state of sequence) {
          for (let frame = 0; frame < 24; frame++) {
            time += 1 / 24;
            creature.animate(time, state, Math.sin(time), true);
            creature.root.updateMatrixWorld(true);
            for (const barrier of barriers) {
              const inverse = barrier.matrixWorld.clone().invert();
              for (const limb of limbs) {
                matrix.multiplyMatrices(inverse, limb.matrixWorld);
                center.set(0, 0, 0).applyMatrix4(matrix);
                const maxRadius = matrix.getMaxScaleOnAxis();
                if (center.length() - maxRadius > 1.03) continue;
                // All barriers are transformed unit spheres. Check the actual limb surface,
                // including fingertips, rather than only the wrist pivot or an AABB.
                const vertices = limb.geometry.getAttribute("position");
                for (let i = 0; i < vertices.count; i++) {
                  point.fromBufferAttribute(vertices, i).applyMatrix4(matrix);
                  const distance = point.length();
                  if (distance < worst) {
                    worst = distance;
                    worstAt = `${id} ${state} t=${time.toFixed(2)}: ${limb.name} against ${barrier.name}`;
                  }
                }
              }
            }
          }
        }
        expect(worst, worstAt).toBeGreaterThan(1.015);
      });

      it(`${label}: the wiping hand travels around, not through, the laptop lid`, () => {
        const creature = buildCreature(id, { detail });
        const lid = creature.root.getObjectByName("laptop-lid")!;
        const arm: THREE.Mesh[] = [];
        creature.root.traverse((obj) => {
          if (
            obj instanceof THREE.Mesh &&
            (obj.name.startsWith("glove-0-1-") || obj.name === "arm-forearm-0-1")
          )
            arm.push(obj);
        });
        const point = new THREE.Vector3();
        const matrix = new THREE.Matrix4();
        let time = 0;
        creature.animate(time, "working", 0, true);
        for (const state of ["done", "working"] as const) {
          for (let frame = 0; frame < 120; frame++) {
            time += 1 / 60;
            creature.animate(time, state, 0, true);
            creature.root.updateMatrixWorld(true);
            const inverse = lid.matrixWorld.clone().invert();
            for (const mesh of arm) {
              matrix.multiplyMatrices(inverse, mesh.matrixWorld);
              const vertices = mesh.geometry.getAttribute("position");
              for (let i = 0; i < vertices.count; i++) {
                point.fromBufferAttribute(vertices, i).applyMatrix4(matrix);
                const inside =
                  Math.abs(point.x) < 0.735 &&
                  point.y > 0.015 &&
                  point.y < 0.595 &&
                  Math.abs(point.z) < 0.025;
                if (inside)
                  throw new Error(`${id} ${state} ${mesh.name} t=${time.toFixed(2)} intersects the lid`);
              }
            }
          }
        }
      });

      it(`${label}: thinking and done have distinct props and the cloth follows the outer lid`, () => {
        const creature = buildCreature(id, { detail });
        const cloud = creature.root.getObjectByName("thought-cloud")!;
        const cloth = creature.root.getObjectByName("polishing-cloth")!;
        const laptop = creature.root.getObjectByName("laptop")!;
        const lid = creature.root.getObjectByName("laptop-lid")!;
        for (const state of states) {
          // Equal times deliberately model a paused/reduced-motion state selection.
          creature.animate(0, state, 0, true);
          expect(cloud.visible).toBe(state === "thinking");
          expect(cloth.visible).toBe(state === "done");
          expect(laptop.visible).toBe(state === "working" || state === "done");
        }
        creature.animate(0, "done", 0, true);
        const point = new THREE.Vector3();
        const positions = [];
        for (let frame = 0; frame < 180; frame++) {
          creature.animate(frame / 30, "done", 0, true);
          creature.root.updateMatrixWorld(true);
          lid.worldToLocal(cloth.getWorldPosition(point));
          positions.push(point.x);
          expect(point.z).toBeCloseTo(0.052, 4);
          expect(Math.abs(point.x) + 0.25).toBeLessThan(0.75);
          expect(point.y - 0.21).toBeGreaterThan(0);
          expect(point.y + 0.21).toBeLessThan(0.62);
        }
        expect(Math.max(...positions) - Math.min(...positions)).toBeGreaterThan(0.45);
      });

      it(`${label}: the laptop is carried at work and put away for thinking and has a stable supporting hand`, () => {
        const creature = buildCreature(id, { detail });
        const laptop = creature.root.getObjectByName("laptop")!;
        const holder = creature.root.getObjectByName(`hand-${id === "sprout" ? 1 : 0}--1`)!;
        creature.animate(0, "working", 0, true);
        const initial = holder.position.clone();
        for (let frame = 1; frame < 120; frame++) {
          creature.animate(frame / 30, "working", 0, true);
          expect(laptop.visible).toBe(true);
          expect(holder.position.distanceTo(initial)).toBeLessThan(0.001);
        }
        creature.animate(4, "thinking", 0, true);
        for (let frame = 1; frame < 60; frame++) creature.animate(4 + frame / 30, "thinking", 0, true);
        expect(laptop.visible).toBe(false);
        // A paused/reduced-motion state change still displays the new pose immediately.
        creature.animate(4 + 59 / 30, "working", 0, true);
        expect(laptop.visible).toBe(true);
        // The carrying hand follows the underside throughout deployment and stowing.
        const wrist = new THREE.Vector3();
        let time = 7;
        for (const state of ["idle", "working", "question", "working"] as const) {
          for (let frame = 0; frame < 50; frame++) {
            time += 1 / 60;
            creature.animate(time, state, 0, true);
            creature.root.updateMatrixWorld(true);
            if (!laptop.visible) continue;
            laptop.worldToLocal(holder.getWorldPosition(wrist));
            expect(wrist.x).toBeCloseTo(-0.63, 4);
            expect(wrist.y * laptop.scale.y).toBeCloseTo(-0.185, 4);
            expect(wrist.z).toBeCloseTo(0, 4);
          }
        }
        // Throttled tabs must not leave the laptop floating during an unrelated state.
        creature.animate(time + 1, "question", 0, true);
        expect(laptop.visible).toBe(false);
      });
    }
});
