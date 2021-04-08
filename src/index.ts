/* Based on https://github.com/clentfort/urql-custom-scalars-exchange, added handling for mutation variables including objects and nested fragments, heavily rewritten */

import { Exchange } from '@urql/core';
import {
    ASTNode,
    buildClientSchema,
    GraphQLScalarType,
    GraphQLType,
    IntrospectionQuery,
    isInputObjectType,
    isScalarType,
    isWrappingType,
    TypeInfo,
    visit,
    visitWithTypeInfo
} from 'graphql';
import { map, pipe } from 'wonka';

type Maybe<T> = null | undefined | T;

type NodePath = (string | { fragment: string })[];

interface NodeWithPath {
    name: string;
    path: NodePath;
}

// TODO: simplify this..
function mapScalar(data: any, path: PropertyKey[], map: (input: any) => any) {
    if (data == null) {
        return data;
    }

    const newData = { ...data };

    let newSubData = newData;
    for (let index = 0; index < path.length - 1; index += 1) {
        const segment = path[index];
        if (Array.isArray(newSubData[segment])) {
            const subPath = path.slice(index + 1);
            newSubData[segment] = newSubData[segment].map((subData: unknown) =>
                mapScalar(subData, subPath, map)
            );
            return newData;
        } else if (newSubData[segment] === null) {
            return newData;
        } else {
            newSubData[segment] = { ...newSubData[segment] };
        }
        newSubData = newSubData[segment];
    }

    const finalSegment = path[path.length - 1];

    if (Array.isArray(newSubData[finalSegment])) {
        newSubData[finalSegment] = newSubData[finalSegment].map(map);
    } else if (newSubData[finalSegment] != null) {
        newSubData[finalSegment] = map(newSubData[finalSegment]);
    }

    return newData;
}

type ScalarMap<Serialized, Deserialized> = {
    serialize: (value: Deserialized) => Serialized,
    deserialize: (value: Serialized) => Deserialized,
}

interface ScalarExchangeOptions {
    scalars: Record<string, ScalarMap<any, any>>,
    schema: IntrospectionQuery,
}

function unpackType(type: Maybe<GraphQLType>): Maybe<GraphQLType> {
    return isWrappingType(type) ? unpackType(type.ofType) : type;
}

function getNodePath(path: readonly (string|number)[], rootNode: ASTNode): NodePath {
    let currentNode = rootNode;

    return path.reduce((queryPath, segment) => {
        // @ts-ignore
        currentNode = currentNode[segment];
        if (currentNode.kind === 'Field') {
            queryPath.push((currentNode.alias ?? currentNode.name).value);
        } else if (currentNode.kind === 'FragmentSpread') {
            queryPath.push({ fragment: currentNode.name.value });
        }
        return queryPath;
    }, [] as NodePath);
}

export default function scalarExchange({
                                           schema,
                                           scalars
                                       }: ScalarExchangeOptions): Exchange {
    const typeInfo = new TypeInfo(buildClientSchema(schema));

    const isMappedScalar = (type: Maybe<GraphQLType>): type is GraphQLScalarType => isScalarType(type) && scalars[type.name] !== undefined;

    return ({ forward }) => (ops$) => {
        return pipe(
            ops$,
            map(operation => {
                // TODO: check if this works for query variables as well, or needs further handling
                const scalarsInVariables: NodeWithPath[] = [];

                const processVariable = (type: Maybe<GraphQLType>, path: string[]) => {
                    const unpacked = unpackType(type);

                    if (isMappedScalar(unpacked)) {
                        scalarsInVariables.push({
                            name: unpacked.name,
                            path
                        });
                    }
                };

                visit(operation.query, visitWithTypeInfo(typeInfo, {
                    VariableDefinition(node, _key, _parent, _astPath, _ancestors) {
                        const type = unpackType(typeInfo.getInputType());

                        if (isInputObjectType(type)) {
                            Object.values(type.getFields()).forEach(subField => processVariable(subField.type, [node.variable.name.value, subField.name]));
                        } else {
                            processVariable(type, [node.variable.name.value]);
                        }
                    }
                }));

                for (const { name, path } of scalarsInVariables) {
                    operation.variables = mapScalar(operation.variables, path as string[], scalars[name].serialize);
                }

                return operation;
            }),
            forward,
            map(result => {
                if (result.data == null) {
                    return result;
                }

                const fragmentsInQuery: Record<string, NodePath> = {};
                const scalarsInQuery: NodeWithPath[] = [];

                visit(result.operation.query, visitWithTypeInfo(typeInfo, {
                    FragmentSpread(node, _key, _parent, astPath, ancestors) {
                        fragmentsInQuery[node.name.value] = getNodePath(astPath, ancestors[0] as ASTNode);
                    },
                    Field(_node, _key, _parent, astPath, ancestors) {
                        const type = unpackType(typeInfo.getType());

                        if (isMappedScalar(type)) {
                            scalarsInQuery.push({
                                name: type.name,
                                path: getNodePath(astPath, ancestors[0] as ASTNode)
                            });
                        }
                    }
                }));

                function isString(s: any): s is string {
                    return typeof s === 'string';
                }

                const resolveFragmentPath = (path: NodePath): string[] => path.flatMap(segment => isString(segment) ? segment : resolveFragmentPath(fragmentsInQuery[segment.fragment]));

                scalarsInQuery.forEach(scalar => result.data = mapScalar(result.data, resolveFragmentPath(scalar.path), scalars[scalar.name].deserialize));

                return result;
            })
        );
    };
}
