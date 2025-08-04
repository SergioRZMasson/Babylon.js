import type { PostProcessRenderPipeline } from "core/index";
import type { FunctionComponent } from "react";

import { SyncedSliderPropertyLine } from "shared-ui-components/fluent/hoc/propertyLines/syncedSliderPropertyLine";
import { BoundProperty } from "../boundProperty";

export const PostProcessGeneralProperties: FunctionComponent<{ context: PostProcessRenderPipeline }> = (props) => {
    const renderPipelineAsAny = props as any;
    return (
        <>
            {renderPipelineAsAny.samples !== undefined && (
                <BoundProperty
                    component={SyncedSliderPropertyLine}
                    nullable={true}
                    defaultValue={1}
                    label="Samples"
                    target={renderPipelineAsAny}
                    propertyKey="samples"
                    min={1}
                    max={64}
                    step={1}
                ></BoundProperty>
            )}
        </>
    );
};
