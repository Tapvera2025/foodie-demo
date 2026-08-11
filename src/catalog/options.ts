/**
 * Variant and add-on group selection rules.
 *
 * PRD CUS-MENU-02: an invalid combination cannot be added to the cart, either
 * client-side or via the API. This module is the server-side half — the client
 * shows the rule before the user breaks it, but the client is not trusted.
 *
 * Shape matches contracts/openapi.yaml #/components/schemas/OptionGroup.
 */

import { AppError } from '../platform/errors.js';
import { paise, type Paise } from '../platform/money.js';

export interface OptionChoice {
  readonly id: string;
  readonly name: string;
  readonly priceDeltaPaise: Paise;
  readonly isAvailable: boolean;
}

export interface OptionGroup {
  readonly id: string;
  readonly name: string;
  readonly minSelect: number;
  readonly maxSelect: number;
  readonly options: readonly OptionChoice[];
}

/**
 * Validates a group definition itself, at menu import time.
 *
 * A malformed group is a menu error, and it must be caught when the vendor
 * uploads their menu rather than when a customer is standing at a table.
 * Interface Specs §4.2.
 */
export function assertValidGroupDefinition(group: OptionGroup): void {
  const problems: string[] = [];

  if (group.options.length === 0) problems.push('group has no options');
  if (group.minSelect < 0) problems.push('minSelect cannot be negative');
  if (group.maxSelect < 1) problems.push('maxSelect must be at least 1');
  if (group.minSelect > group.maxSelect) problems.push('minSelect exceeds maxSelect');
  if (group.minSelect > group.options.length) {
    problems.push('minSelect exceeds the number of options');
  }

  const ids = new Set<string>();
  for (const o of group.options) {
    if (ids.has(o.id)) problems.push(`duplicate option id "${o.id}"`);
    ids.add(o.id);
  }

  // A required group whose available options cannot satisfy minSelect is
  // unorderable. Better to fail the import than to ship an item nobody can buy.
  const available = group.options.filter((o) => o.isAvailable).length;
  if (group.minSelect > available) {
    problems.push(
      `group requires ${group.minSelect} selections but only ${available} options are available`,
    );
  }

  if (problems.length > 0) {
    throw new AppError('OPTION_RULE_VIOLATION', `group "${group.name}": ${problems.join('; ')}`);
  }
}

export interface SelectionResult {
  /** Sum of the chosen options' price deltas. */
  readonly priceDeltaPaise: Paise;
  readonly chosen: readonly OptionChoice[];
}

/**
 * Validates a customer's selection against every group for an item.
 *
 * Rejects, with the group named so the client can highlight it:
 *   - too few or too many selections in a group
 *   - an unknown option id
 *   - the same option chosen twice
 *   - an option that is out of stock
 */
export function validateSelection(
  groups: readonly OptionGroup[],
  selectedOptionIds: readonly string[],
): SelectionResult {
  const seen = new Set<string>();
  for (const id of selectedOptionIds) {
    if (seen.has(id)) {
      throw new AppError('OPTION_RULE_VIOLATION', `option "${id}" selected more than once`);
    }
    seen.add(id);
  }

  const known = new Map<string, { group: OptionGroup; option: OptionChoice }>();
  for (const group of groups) {
    for (const option of group.options) known.set(option.id, { group, option });
  }

  for (const id of selectedOptionIds) {
    if (!known.has(id)) {
      throw new AppError('OPTION_RULE_VIOLATION', `unknown option "${id}"`, { optionId: id });
    }
  }

  const chosen: OptionChoice[] = [];
  let delta = 0;

  for (const group of groups) {
    const inGroup = group.options.filter((o) => selectedOptionIds.includes(o.id));

    if (inGroup.length < group.minSelect) {
      throw new AppError(
        'OPTION_RULE_VIOLATION',
        `choose at least ${group.minSelect} from "${group.name}"`,
        { groupId: group.id },
      );
    }
    if (inGroup.length > group.maxSelect) {
      throw new AppError(
        'OPTION_RULE_VIOLATION',
        `choose at most ${group.maxSelect} from "${group.name}"`,
        { groupId: group.id },
      );
    }

    for (const option of inGroup) {
      if (!option.isAvailable) {
        throw new AppError('ITEM_UNAVAILABLE', `"${option.name}" is not available`, {
          optionId: option.id,
          groupId: group.id,
        });
      }
      chosen.push(option);
      delta += option.priceDeltaPaise;
    }
  }

  return { priceDeltaPaise: paise(delta), chosen };
}
