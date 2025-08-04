import type { ServiceDefinition } from "../../../modularity/serviceDefinition";
import type { IPropertiesService } from "./propertiesService";
import type { ISelectionService } from "../../selectionService";

import { PropertiesServiceIdentity } from "./propertiesService";
import { SelectionServiceIdentity } from "../../selectionService";

import { MeshGeneralProperties } from "../../../components/properties/meshes/meshProperties";
import { Mesh } from "core/Meshes/mesh";

export const MeshPropertiesServiceDefinition: ServiceDefinition<[], [IPropertiesService, ISelectionService]> = {
    friendlyName: "Mesh Properties",
    consumes: [PropertiesServiceIdentity, SelectionServiceIdentity],
    factory: (propertiesService) => {
        const meshContentRegistration = propertiesService.addSectionContent({
            key: "Mesh Properties",
            predicate: (entity: unknown) => entity instanceof Mesh,
            content: [
                {
                    section: "General",
                    component: MeshGeneralProperties,
                },
            ],
        });

        return {
            dispose: () => {
                meshContentRegistration.dispose();
            },
        };
    },
};
