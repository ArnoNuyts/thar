import type { Todos } from "./Todos.ts";

export interface TagSources {
  projects: string[];
  contexts: string[];
}

/**
 * Collects the unique, sorted projects and contexts used by the given todos.
 */
export const collectTagSources = (todos: Todos): TagSources => {
  const projects = new Set<string>();
  const contexts = new Set<string>();

  todos.forEach((todo) => {
    todo.projects.forEach((project) => projects.add(project));
    todo.contexts.forEach((context) => contexts.add(context));
  });

  return {
    projects: Array.from(projects).sort(),
    contexts: Array.from(contexts).sort(),
  };
};
