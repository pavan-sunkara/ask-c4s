/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

import { XMLParser } from "fast-xml-parser";
import { c4cText } from "./client.js";

const SERVICE_REQUEST_COLLECTION = "ServiceRequestCollection";

type XmlRecord = Record<string, unknown>;

export type EntityProperty = {
  name: string;
  type?: string;
};

export type NavigationProperty = {
  name: string;
  relationship?: string;
  fromRole?: string;
  toRole?: string;
  type?: string;
};

export type EntityType = {
  name: string;
  fullName: string;
  keyProperties: string[];
  properties: EntityProperty[];
  navigationProperties: NavigationProperty[];
};

export type EntitySet = {
  name: string;
  entityTypeName: string;
};

export type AssociationEnd = {
  role?: string;
  type?: string;
  multiplicity?: string;
};

export type Association = {
  name: string;
  fullName: string;
  ends: AssociationEnd[];
};

export type NavigationCandidate = NavigationProperty & {
  score: number;
  reasons: string[];
  targetEntityType?: string;
  targetMultiplicity?: string;
};

export type ODataMetadata = {
  entitySets: EntitySet[];
  entityTypes: EntityType[];
  associations: Association[];
  entitySetByName: Map<string, EntitySet>;
  entityTypeByName: Map<string, EntityType>;
  entityTypeByFullName: Map<string, EntityType>;
  associationByName: Map<string, Association>;
};

let rawMetadataCache: string | undefined;
let parsedMetadataCache: ODataMetadata | undefined;

function asRecord(value: unknown): XmlRecord | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as XmlRecord;
  }

  return undefined;
}

function asArray<T>(value: unknown): T[] {
  if (value === undefined || value === null) {
    return [];
  }

  return Array.isArray(value) ? (value as T[]) : [value as T];
}

function attr(node: XmlRecord, name: string) {
  const value = node[name];
  return typeof value === "string" ? value : undefined;
}

function lastSegment(value: string) {
  return value.split(".").at(-1) ?? value;
}

function stripCollectionType(typeName: string) {
  const match = /^Collection\((.+)\)$/.exec(typeName);
  return match?.[1] ?? typeName;
}

function getSchemas(parsed: XmlRecord) {
  const edmx = asRecord(parsed.Edmx);
  const dataServices = asRecord(edmx?.DataServices);
  return asArray<XmlRecord>(dataServices?.Schema ?? parsed.Schema);
}

export async function getRawMetadata(refresh = false) {
  if (!rawMetadataCache || refresh) {
    rawMetadataCache = await c4cText("/$metadata");
    parsedMetadataCache = undefined;
  }

  return rawMetadataCache;
}

export async function getParsedMetadata(refresh = false) {
  if (!parsedMetadataCache || refresh) {
    parsedMetadataCache = parseODataMetadata(await getRawMetadata(refresh));
  }

  return parsedMetadataCache;
}

export function parseODataMetadata(xml: string): ODataMetadata {
  const parser = new XMLParser({
    attributeNamePrefix: "",
    ignoreAttributes: false,
    removeNSPrefix: true
  });

  const parsed = asRecord(parser.parse(xml));
  if (!parsed) {
    throw new Error("SAP C4C metadata could not be parsed as XML.");
  }

  const entitySets: EntitySet[] = [];
  const entityTypes: EntityType[] = [];
  const associations: Association[] = [];

  for (const schema of getSchemas(parsed)) {
    const namespace = attr(schema, "Namespace") ?? "";

    for (const entityTypeNode of asArray<XmlRecord>(schema.EntityType)) {
      const name = attr(entityTypeNode, "Name");
      if (!name) {
        continue;
      }

      const keyNode = asRecord(entityTypeNode.Key);
      const keyProperties = asArray<XmlRecord>(keyNode?.PropertyRef)
        .map((propertyRef) => attr(propertyRef, "Name"))
        .filter((value): value is string => Boolean(value));

      const properties = asArray<XmlRecord>(entityTypeNode.Property).flatMap((property) => {
        const propertyName = attr(property, "Name");
        return propertyName ? [{ name: propertyName, type: attr(property, "Type") }] : [];
      });

      const navigationProperties = asArray<XmlRecord>(entityTypeNode.NavigationProperty).flatMap((property) => {
        const propertyName = attr(property, "Name");

        return propertyName
          ? [
              {
                name: propertyName,
                relationship: attr(property, "Relationship"),
                fromRole: attr(property, "FromRole"),
                toRole: attr(property, "ToRole"),
                type: attr(property, "Type")
              }
            ]
          : [];
      });

      entityTypes.push({
        name,
        fullName: namespace ? `${namespace}.${name}` : name,
        keyProperties,
        properties,
        navigationProperties
      });
    }

    for (const associationNode of asArray<XmlRecord>(schema.Association)) {
      const name = attr(associationNode, "Name");
      if (!name) {
        continue;
      }

      associations.push({
        name,
        fullName: namespace ? `${namespace}.${name}` : name,
        ends: asArray<XmlRecord>(associationNode.End).map((end) => ({
          role: attr(end, "Role"),
          type: attr(end, "Type"),
          multiplicity: attr(end, "Multiplicity")
        }))
      });
    }

    for (const containerNode of asArray<XmlRecord>(schema.EntityContainer)) {
      for (const entitySetNode of asArray<XmlRecord>(containerNode.EntitySet)) {
        const name = attr(entitySetNode, "Name");
        const entityTypeName = attr(entitySetNode, "EntityType");
        if (name && entityTypeName) {
          entitySets.push({ name, entityTypeName });
        }
      }
    }
  }

  const entitySetByName = new Map(entitySets.map((entitySet) => [entitySet.name, entitySet]));
  const entityTypeByFullName = new Map(entityTypes.map((entityType) => [entityType.fullName, entityType]));
  const entityTypeByName = new Map(entityTypes.map((entityType) => [entityType.name, entityType]));
  const associationByName = new Map<string, Association>();

  for (const association of associations) {
    associationByName.set(association.fullName, association);
    associationByName.set(association.name, association);
  }

  return {
    entitySets,
    entityTypes,
    associations,
    entitySetByName,
    entityTypeByName,
    entityTypeByFullName,
    associationByName
  };
}

export function resolveEntityType(metadata: ODataMetadata, typeName: string) {
  const normalized = stripCollectionType(typeName);
  return metadata.entityTypeByFullName.get(normalized) ?? metadata.entityTypeByName.get(lastSegment(normalized));
}

export function getServiceRequestEntity(metadata: ODataMetadata) {
  const entitySet =
    metadata.entitySetByName.get(SERVICE_REQUEST_COLLECTION) ??
    metadata.entitySets.find((candidate) => /service.*request/i.test(candidate.name));

  if (!entitySet) {
    return undefined;
  }

  const entityType = resolveEntityType(metadata, entitySet.entityTypeName);
  if (!entityType) {
    return undefined;
  }

  return { entitySet, entityType };
}

export function resolveNavigationTarget(metadata: ODataMetadata, nav: NavigationProperty) {
  if (nav.type) {
    const targetEntityType = stripCollectionType(nav.type);
    return {
      targetEntityType,
      targetMultiplicity: nav.type.startsWith("Collection(") ? "*" : "1"
    };
  }

  if (!nav.relationship) {
    return {};
  }

  const association =
    metadata.associationByName.get(nav.relationship) ??
    metadata.associationByName.get(lastSegment(nav.relationship));

  const targetEnd =
    association?.ends.find((end) => end.role === nav.toRole) ??
    association?.ends.find((end) => end.role !== nav.fromRole);

  return {
    targetEntityType: targetEnd?.type,
    targetMultiplicity: targetEnd?.multiplicity
  };
}

const HISTORY_KEYWORDS = [
  { label: "history", pattern: /histor/i, weight: 100 },
  { label: "service activity", pattern: /activity|interaction|visit|appointment|confirmation|work/i, weight: 35 },
  { label: "equipment context", pattern: /installed|registered|equipment|instrument|serial|product/i, weight: 30 },
  { label: "notes and documents", pattern: /note|text|document|attachment|description/i, weight: 25 },
  { label: "service request", pattern: /service|request|ticket|incident/i, weight: 20 },
  { label: "customer context", pattern: /customer|account|party/i, weight: 15 },
  { label: "status context", pattern: /status|life.?cycle|processing/i, weight: 10 }
];

function scoreNavigationCandidate(nav: NavigationProperty, targetEntityType?: string, targetMultiplicity?: string) {
  const haystack = [nav.name, nav.type, nav.relationship, targetEntityType].filter(Boolean).join(" ");
  let score = targetMultiplicity === "*" ? 5 : 0;
  const reasons: string[] = [];

  for (const keyword of HISTORY_KEYWORDS) {
    if (keyword.pattern.test(haystack)) {
      score += keyword.weight;
      reasons.push(keyword.label);
    }
  }

  return { score, reasons };
}

export function discoverServiceHistoryCandidates(metadata: ODataMetadata) {
  const serviceRequest = getServiceRequestEntity(metadata);
  if (!serviceRequest) {
    return [];
  }

  return serviceRequest.entityType.navigationProperties
    .map((nav) => {
      const target = resolveNavigationTarget(metadata, nav);
      const scored = scoreNavigationCandidate(nav, target.targetEntityType, target.targetMultiplicity);

      return {
        ...nav,
        ...target,
        ...scored
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
}

export function summarizeMetadata(metadata: ODataMetadata, entitySetName?: string) {
  const requestedEntitySet = entitySetName ? metadata.entitySetByName.get(entitySetName) : undefined;
  const serviceRequest = getServiceRequestEntity(metadata);
  const entitySet = requestedEntitySet ?? serviceRequest?.entitySet;
  const entityType = entitySet ? resolveEntityType(metadata, entitySet.entityTypeName) : undefined;

  return {
    counts: {
      entitySets: metadata.entitySets.length,
      entityTypes: metadata.entityTypes.length,
      associations: metadata.associations.length
    },
    selectedEntitySet: entitySet
      ? {
          name: entitySet.name,
          entityTypeName: entitySet.entityTypeName,
          keyProperties: entityType?.keyProperties ?? [],
          properties: entityType?.properties ?? [],
          navigationProperties:
            entityType?.navigationProperties.map((nav) => ({
              ...nav,
              ...resolveNavigationTarget(metadata, nav)
            })) ?? []
        }
      : undefined,
    serviceHistoryCandidates: discoverServiceHistoryCandidates(metadata).map((candidate) => ({
      name: candidate.name,
      targetEntityType: candidate.targetEntityType,
      targetMultiplicity: candidate.targetMultiplicity,
      score: candidate.score,
      reasons: candidate.reasons
    }))
  };
}
