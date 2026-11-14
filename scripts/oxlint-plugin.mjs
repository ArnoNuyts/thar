/**
 * Local oxlint rules, loaded through `jsPlugins` in `.oxlintrc.json`.
 *
 * Oxlint's built-in plugins do not police `Date` arithmetic, so the rules here
 * keep calendar math in date-fns, where month ends, leap years and DST are
 * handled once instead of per call site.
 */

const DATE_MUTATORS = new Set([
  "setDate",
  "setMonth",
  "setFullYear",
  "setHours",
  "setMinutes",
  "setSeconds",
  "setMilliseconds",
  "setUTCDate",
  "setUTCMonth",
  "setUTCFullYear",
  "setUTCHours",
  "setUTCMinutes",
  "setUTCSeconds",
  "setUTCMilliseconds",
]);

const CALENDAR_ACCESSORS = new Set([
  "getDate",
  "getMonth",
  "getFullYear",
  "getDay",
  "getUTCDate",
  "getUTCMonth",
  "getUTCFullYear",
  "getUTCDay",
]);

const ARITHMETIC_OPERATORS = new Set(["+", "-", "*", "/", "%"]);

/** @returns {string | null} */
const memberName = (node) => {
  if (node?.type !== "MemberExpression") return null;
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  if (
    node.computed &&
    node.property.type === "Literal" &&
    typeof node.property.value === "string"
  ) {
    return node.property.value;
  }
  return null;
};

/**
 * True when an accessor call is part of `date.getDate() + 1` style arithmetic.
 */
const isArithmeticOperand = (node) =>
  node.parent?.type === "BinaryExpression" &&
  ARITHMETIC_OPERATORS.has(node.parent.operator);

/**
 * True when the accessor is the argument of a mutator we already report, as in
 * `date.setDate(date.getDate() + 1)`, so the pair yields one diagnostic.
 */
const isInsideReportedMutator = (node) => {
  let parent = node.parent;
  while (parent) {
    if (parent.type === "CallExpression") {
      return DATE_MUTATORS.has(memberName(parent.callee));
    }
    if (
      parent.type !== "BinaryExpression" &&
      parent.type !== "UnaryExpression" &&
      parent.type !== "ParenthesizedExpression" &&
      parent.type !== "TSAsExpression" &&
      parent.type !== "TSNonNullExpression"
    ) {
      return false;
    }
    parent = parent.parent;
  }
  return false;
};

const noNativeDateMath = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Use date-fns instead of native Date mutation and calendar arithmetic",
    },
    messages: {
      mutate:
        "`{{name}}()` mutates a Date with date math; use date-fns (addDays, addMonths, addYears, subDays, …) so month ends, leap years and DST stay correct.",
      arithmetic:
        "Arithmetic on `{{name}}()` is date math; use date-fns (addDays, addMonths, addYears, differenceInDays, …) instead.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const name = memberName(node.callee);
        if (!name) return;

        if (DATE_MUTATORS.has(name)) {
          if (node.arguments.length === 0) return;
          context.report({
            node: node.callee,
            messageId: "mutate",
            data: { name },
          });
          return;
        }

        if (
          CALENDAR_ACCESSORS.has(name) &&
          isArithmeticOperand(node) &&
          !isInsideReportedMutator(node)
        ) {
          context.report({
            node,
            messageId: "arithmetic",
            data: { name },
          });
        }
      },
    };
  },
};

export default {
  meta: { name: "thar" },
  rules: {
    "no-native-date-math": noNativeDateMath,
  },
};
