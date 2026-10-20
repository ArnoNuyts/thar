import { useMemo } from "react";
import type { Todos } from "../logic/Todos.ts";
import { collectTagSources, type TagSources } from "../logic/tag-sources.ts";

export const useTagSources = (todos: Todos): TagSources =>
  useMemo(() => collectTagSources(todos), [todos]);
