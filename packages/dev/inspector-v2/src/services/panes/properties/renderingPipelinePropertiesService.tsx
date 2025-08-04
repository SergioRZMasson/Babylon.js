import { PostProcessRenderPipeline } from "core/PostProcesses";
import type { ServiceDefinition } from "../../../modularity/serviceDefinition";
import type { IPropertiesService } from "./propertiesService";

import { PropertiesServiceIdentity } from "./propertiesService";
import { PostProcessGeneralProperties } from "../../../components/properties/renderPipelines/postProcessingRenderPipelineProperties";

export const RenderingPipelinePropertiesServiceDefinition: ServiceDefinition<[], [IPropertiesService]> = {
    friendlyName: "Rendering Pipeline Properties",
    consumes: [PropertiesServiceIdentity],
    factory: (propertiesService) => {
        const postProcessContentRegistration = propertiesService.addSectionContent({
            key: "Post Process Pipeline General Properties",
            predicate: (entity: unknown) => entity instanceof PostProcessRenderPipeline,
            content: [
                {
                    section: "General",
                    component: ({ context }) => <PostProcessGeneralProperties context={context} />,
                },
            ],
        });

        return {
            dispose: () => {
                postProcessContentRegistration.dispose();
            },
        };
    },
};
