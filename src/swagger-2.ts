import * as prettier from 'prettier';

export interface Swagger2 {
  definitions: {
    [index: string]: Swagger2Definition;
  };
}

export interface Swagger2Definition {
  $ref?: string;
  allOf?: Swagger2Definition[];
  description?: string;
  enum?: string[];
  format?: string;
  items?: Swagger2Definition;
  oneOf?: Swagger2Definition[];
  properties?: { [index: string]: Swagger2Definition };
  required?: string[];
  type?: 'array' | 'boolean' | 'integer' | 'number' | 'object' | 'string';
}

// Primitives only!
const TYPES: { [index: string]: string } = {
  boolean: 'Boolean',
  float: 'Float',
  integer: 'Int',
  string: 'String',
};

function camelCase(name: string): string {
  return name.replace(/(-|_|\.|\s)+[a-z]/g, letter =>
    letter.toUpperCase().replace(/[^0-9a-z]/gi, '')
  );
}

function snakeCase(name: string): string {
  return name
    .replace(/(-|\.|\s)/g, '_')
    .replace(/[A-Z]/g, letter => `_${letter}`)
    .toUpperCase();
}

function parse(spec: Swagger2): string {
  const queue: [string, Swagger2Definition][] = [];
  const enumQueue: [string, (string | number)[]][] = [];
  const unionQueue: [string, Swagger2Definition[]][] = [];
  const output: string[] = [];

  const { definitions } = spec;

  function getRef(lookup: string): [string, Swagger2Definition] {
    const ID = lookup.replace('#/definitions/', '');
    const ref = definitions[ID];
    return [ID, ref];
  }

  function getType(definition: Swagger2Definition, nestedName: string): string {
    const { $ref, items, type, ...value } = definition;

    const DEFAULT_TYPE = 'Scalar';

    if ($ref) {
      const [refName, refProperties] = getRef($ref);
      if (refName === 'ID') {
        return 'ID';
      }
      // If a shallow array interface, return that instead
      if (refProperties.items && refProperties.items.$ref) {
        return getType(refProperties, refName);
      }
      if (refProperties.type && TYPES[refProperties.type]) {
        return TYPES[refProperties.type];
      }
      return refName || DEFAULT_TYPE;
    }

    if (type === 'number') {
      if (value.format && value.format === 'float') {
        return TYPES.float;
      }
      return TYPES.integer;
    }

    if (items && items.$ref) {
      const [refName] = getRef(items.$ref);
      return `[${getType(items, refName)}]`;
    } else if (items && items.type && TYPES[items.type]) {
      return `[${TYPES[items.type]}]`;
    }

    if (Array.isArray(value.oneOf) && value.oneOf.length > 0) {
      unionQueue.push([nestedName, value.oneOf]);
      return nestedName;
    }

    if (value.properties) {
      // If this is a nested object, let’s add it to the stack for later
      queue.push([nestedName, { $ref, items, type, ...value }]);
      return nestedName;
    }

    if (type) {
      return TYPES[type] || type || DEFAULT_TYPE;
    }

    return DEFAULT_TYPE;
  }

  function buildNextEnum([ID, options]: [string, (string | number)[]]): void {
    output.push(`enum ${ID} {`);
    options.forEach(option => {
      if (typeof option === 'number' || isNaN(parseInt(option, 10)) === false) {
        const lastWord = ID.search(/[A-Z](?=[^A-Z]*$)/);
        const name = ID.substr(lastWord, ID.length);
        output.push(`${name}${option}`);
      } else {
        output.push(snakeCase(option));
      }
    });
    output.push('}');
  }

  function buildNextUnion([ID, types]: [string, Swagger2Definition[]]): void {
    const union = types.map(type => getType(type, '')).join(' | ');
    output.push(`union ${ID} = ${union}`);
  }

  function buildNextObject(): void {
    const nextObject = queue.pop();
    if (!nextObject) {
      // Geez TypeScript it’s going to be OK
      return;
    }
    const [ID, { allOf, properties, required }] = nextObject;

    let allProperties: { [index: string]: Swagger2Definition } = {};

    // Include allOf, if specified
    if (Array.isArray(allOf)) {
      allOf.forEach(item => {
        // Add “implements“ if this references other items
        if (item.$ref) {
          const refProperties = getRef(item.$ref)[1];
          if (refProperties && refProperties.properties) {
            allProperties = { ...allProperties, ...refProperties.properties };
          }
        } else if (item.properties) {
          allProperties = { ...allProperties, ...item.properties };
        }
      });
    }

    // Then add new properties
    if (properties && Object.keys(properties).length) {
      allProperties = { ...allProperties, ...properties };
    }

    // If nothing’s here, let’s skip this one.
    if (!Object.keys(allProperties).length) {
      return;
    }

    // Open type
    output.push(`type ${camelCase(ID)} {`);

    // Populate type
    Object.entries(allProperties).forEach(([key, value]) => {
      const optional = !Array.isArray(required) || required.indexOf(key) === -1;
      const nonNullable = optional ? '' : '!';
      const name = camelCase(key);
      const newID = camelCase(`${ID}_${key}`);
      const type = getType(value, newID);

      if (typeof value.description === 'string') {
        // Print out descriptions as comments, but only if there’s something there (.*)
        output.push(`"${value.description.replace(/\n$/, '').replace(/\n/g, ' ')}"`);
      }

      // Save enums for later
      if (Array.isArray(value.enum)) {
        enumQueue.push([newID, value.enum]);
        output.push(`${name}: ${newID}${nonNullable}`);
        return;
      }

      output.push(`${name}: ${type}${nonNullable}`);
    });

    // Close type
    output.push('}');

    // Clean up enumQueue
    while (enumQueue.length > 0) {
      const nextEnum = enumQueue.pop();
      if (nextEnum) {
        buildNextEnum(nextEnum);
      }
    }

    // Clean up unionQueue
    while (unionQueue.length > 0) {
      const nextUnion = unionQueue.pop();
      if (nextUnion) {
        buildNextUnion(nextUnion);
      }
    }
  }

  // Begin parsing top-level entries
  Object.entries(definitions).forEach(entry => queue.push(entry));
  queue.sort((a, b) => a[0].localeCompare(b[0]));
  while (queue.length > 0) {
    buildNextObject();
  }

  return prettier.format(output.join('\n'), { parser: 'graphql' });
}

export default parse;
