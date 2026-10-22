/**
 * Local ESLint rule: the statements of a control statement's block are on their own lines.
 *
 * `if (!entity) { return; }` is not written on one line here; the style guide puts the block on the following lines.
 * Only the blocks of `if`/`else`, the loops and `try`/`catch`/`finally` are checked: a one-line arrow function or
 * getter is not a control statement. A block with a comment inside is reported but not fixed.
 */

/** @type {import('eslint').Rule.RuleModule} */
const blockOnOwnLines = {
  meta: {
    type: 'layout',
    docs: {
      description: 'Require the statements of the block of a control statement to be on their own lines.',
    },
    fixable: 'whitespace',
    schema: [],
    messages: {
      ownLines: 'Put the statements of this block on their own lines.',
    },
  },

  create(context) {
    const { sourceCode } = context;

    /**
     * Reports a block of a control statement that has statements and starts and ends on one line.
     * @param {import('estree').Node | null | undefined} block The body of the statement.
     */
    function check(block) {
      if (block === null || block === undefined || block.type !== 'BlockStatement') {
        return;
      }

      const { loc } = block;

      if (block.body.length === 0 || !loc || loc.start.line !== loc.end.line) {
        return;
      }

      context.report({
        node: block,
        messageId: 'ownLines',
        fix(fixer) {
          if (sourceCode.getCommentsInside(block).length > 0) {
            return null;
          }

          // the indentation of the line the block starts on, which is the one of its control statement
          const indent = /^\s*/.exec(sourceCode.lines[loc.start.line - 1])?.[0] ?? '';
          const statements = block.body.map((statement) => `${indent}  ${sourceCode.getText(statement)}`);

          return fixer.replaceText(block, `{\n${statements.join('\n')}\n${indent}}`);
        },
      });
    }

    return {
      IfStatement(node) {
        check(node.consequent);
        check(node.alternate);
      },
      ForStatement(node) {
        check(node.body);
      },
      ForInStatement(node) {
        check(node.body);
      },
      ForOfStatement(node) {
        check(node.body);
      },
      WhileStatement(node) {
        check(node.body);
      },
      DoWhileStatement(node) {
        check(node.body);
      },
      TryStatement(node) {
        check(node.block);
        check(node.handler?.body);
        check(node.finalizer);
      },
    };
  },
};

export default {
  rules: {
    'block-on-own-lines': blockOnOwnLines,
  },
};
