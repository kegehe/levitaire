import { describe, expect, it } from "vitest";
import { moveItemToIndex } from "./order";

const items = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
const ids = (list: { id: string }[]) => list.map((item) => item.id);

describe("moveItemToIndex", () => {
  it("moves an item forward into the hovered slot", () => {
    expect(ids(moveItemToIndex(items, "a", 2)!)).toEqual(["b", "c", "a", "d"]);
  });

  it("moves an item backward into the hovered slot", () => {
    expect(ids(moveItemToIndex(items, "d", 1)!)).toEqual(["a", "d", "b", "c"]);
  });

  it("moves the last item to the first slot", () => {
    expect(ids(moveItemToIndex(items, "d", 0)!)).toEqual(["d", "a", "b", "c"]);
  });

  it("clamps an out-of-range slot to the last item", () => {
    expect(ids(moveItemToIndex(items, "a", 99)!)).toEqual(["b", "c", "d", "a"]);
  });

  it("returns null when nothing changes", () => {
    expect(moveItemToIndex(items, "b", 1)).toBeNull();
    expect(moveItemToIndex(items, "missing", 0)).toBeNull();
  });

  it("does not mutate the input", () => {
    moveItemToIndex(items, "a", 3);
    expect(ids(items)).toEqual(["a", "b", "c", "d"]);
  });
});
